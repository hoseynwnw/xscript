/*
 * Quantumult X 定时任务脚本 - 孩子作业提醒
 * 功能: 获取班级小管家当日作业，OCR识别图片内容，推送通知
 * 
 * ========== QuanX 配置 ==========
 * 将下面这行添加到 Quantumult X 配置文件的 [task_local] 段落中:
 * 
 * event-interaction 0 0 17 * * 1-5, tag=📚 孩子作业, script-path=homework_quanx.js
 * 
 * 说明: 工作日(周一至周五) 每天下午5:00 自动执行，获取当日作业并推送通知
 * 也可在 QuanX 的 Task 界面左滑手动触发执行
 * ================================
 */

// ============ 配置区（按需修改） ============
const API = "https://b.welife001.com/info/getParent";
const AUTH = "**********";
const MEMBERS = "*******************";
const IMG_HOST = "https://img.banjixiaoguanjia.com";
const OCR_API = "https://qianfan.baidubce.com/v2/chat/completions";
const OCR_TOKEN = "Bearer ************************";

// OCR 最大识别数（每个科目的图片一起发，避免脚本超时约30秒）
const MAX_OCR_COUNT = 6;

// ============ 日期工具函数 ============

// 获取北京时间的 Date 对象
function getBeijingDate() {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcMs + 8 * 3600000);
}

// 将 Date 对象格式化为 YYYY-MM-DD
function formatDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
}

// 将时间戳转为北京时间日期字符串
function tsToBeijingDateStr(ts) {
    const d = new Date(ts);
    const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
    const bj = new Date(utcMs + 8 * 3600000);
    return formatDateStr(bj);
}

// 核心逻辑：计算应获取哪天的作业（周末回退到周五）
function getTargetDate() {
    const now = getBeijingDate();
    const dow = now.getDay(); // 0=周日, 1=周一, ..., 6=周六

    if (dow === 6) {
        now.setDate(now.getDate() - 1);
        console.log("🕒 周六，目标日期调整为周五");
    } else if (dow === 0) {
        now.setDate(now.getDate() - 2);
        console.log("🕒 周日，目标日期调整为周五");
    } else {
        console.log("🕒 工作日，获取今日作业");
    }

    return formatDateStr(now);
}

// ============ OCR 识别 ============

function doOCR(imageUrls) {
    const payload = {
        model: "qianfan-ocr",
        messages: [{
            role: "user",
            content: [
                ...imageUrls.map(function(url) {
                    return { type: "image_url", image_url: { url: url } };
                }),
                {
                    type: "text",
                    text: "将这些作业文字写出来，不要增加无关的，要求仔细辨别"
                }
            ]
        }]
    };

    return $task.fetch({
        url: OCR_API,
        method: "POST",
        headers: {
            "Authorization": OCR_TOKEN,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    }).then(function(response) {
        if (response.statusCode !== 200) {
            return "[OCR请求失败:" + response.statusCode + "]";
        }
        var result = JSON.parse(response.body);
        return (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content) || "未能识别文字";
    }).catch(function(err) {
        return "[OCR异常:" + err.message + "]";
    });
}

// ============ 延时函数 ============

function sleep(ms) {
    return new Promise(function(resolve) {
        setTimeout(resolve, ms);
    });
}

// ============ 主流程 ============

(async () => {
    try {
        // 1. 计算目标日期
        var targetDate = getTargetDate();
        console.log("📅 目标日期: " + targetDate);

        // 2. 请求作业接口
        var url = API + "?members=" + encodeURIComponent(MEMBERS) + "&type=-1&date=-1&page=0&size=20&isRecent=false";
        console.log("🌐 请求作业接口...");

        var res = await $task.fetch({
            url: url,
            method: "GET",
            headers: {
                "authorization": AUTH,
                "app-info": "0/3.7.5/930",
                "content-type": "application/json"
            }
        });

        if (res.statusCode !== 200) {
            $notify("📚 作业获取失败", "HTTP " + res.statusCode, "请检查网络或授权是否过期");
            $done();
            return;
        }

        var json = JSON.parse(res.body);
        if (json.code !== 0) {
            $notify("📚 作业接口错误", "", json.msg || "未知业务错误");
            $done();
            return;
        }

        var list = json.data || [];
        console.log("📦 作业总数: " + list.length);

        // 3. 过滤目标日期的作业
        var filtered = list.filter(function(item) {
            return tsToBeijingDateStr(item.create_at) === targetDate;
        });

        console.log("🎯 匹配作业数: " + filtered.length);

        if (filtered.length === 0) {
            $notify("📚 作业提醒", targetDate + " 暂无作业", "可能是周末/假期，或老师尚未布置");
            $done();
            return;
        }

        console.log("\n========== 📚 孩子作业 (" + targetDate + ") ==========\n");

        // 4. 逐条处理作业
        var lines = [];
        var ocrCount = 0;

        for (var i = 0; i < filtered.length; i++) {
            var item = filtered[i];
            var subject = item.subject || "未知科目";
            var title = item.title || "无标题";
            var textContent = item.text_content || "";
            var photos = item.photo_content || [];

            var line = "📌 " + subject + " | " + title;

            // 有文字内容则附加
            if (textContent && textContent.trim()) {
                line += "\n   📝 " + textContent.trim().substring(0, 200);
            }

            // 有图片且未超过OCR限制则识别
            var ocrText = "";
            if (photos.length > 0 && ocrCount < MAX_OCR_COUNT) {
                console.log("🔍 OCR识别: " + subject + " (" + photos.length + "张图)");
                var imageUrls = photos.map(function(p) { return IMG_HOST + "/" + p; });
                ocrText = await doOCR(imageUrls);
                if (ocrText && !ocrText.startsWith("[")) {
                    line += "\n   🔍 " + ocrText.substring(0, 500);
                } else if (ocrText) {
                    line += "\n   " + ocrText;
                }
                ocrCount++;
                // 间隔1秒避免请求过快
                if (ocrCount < MAX_OCR_COUNT && i < filtered.length - 1) {
                    await sleep(1000);
                }
            } else if (photos.length > 0) {
                line += "\n   📷 含" + photos.length + "张图片";
            }

            lines.push(line);

            // 在日志中输出详细内容
            console.log("---------- " + (i + 1) + "/" + filtered.length + " ----------");
            console.log("📌 科目: " + subject);
            console.log("📌 标题: " + title);
            if (textContent && textContent.trim()) {
                console.log("📝 内容: " + textContent.trim());
            }
            if (photos.length > 0) {
                console.log("📷 图片数: " + photos.length + "张");
                photos.forEach(function(p, idx) {
                    console.log("   图片" + (idx + 1) + ": " + IMG_HOST + "/" + p);
                });
            }
            if (ocrText) {
                console.log("🔍 OCR结果: " + ocrText);
            }
            console.log("");  // 空行分隔
        }

        console.log("========== 共" + filtered.length + "项作业 ==========\n");

        // 5. 发送通知
        var title = "📚 孩子作业 (" + targetDate + ")";
        var subtitle = "共" + filtered.length + "项作业";
        var body = lines.join("\n\n");

        // 如果有未识别的图片，提示
        var unocr = filtered.reduce(function(cnt, it) {
            return cnt + ((it.photo_content && it.photo_content.length > 0) ? 1 : 0);
        }, 0) - ocrCount;
        if (unocr > 0) {
            body += "\n\n💡 另有" + unocr + "项含图片未OCR（可手动执行脚本查看）";
        }

        $notify(title, subtitle, body);

        console.log("✅ 作业推送完成");

    } catch (e) {
        console.error("🚨 脚本异常: " + e.message);
        $notify("📚 作业脚本异常", "", e.message);
    }

    $done();
})();
