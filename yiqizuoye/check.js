/**
 * ==========================================
 * 脚本名称：17作业汇总查询 (Task 版)
 * 脚本作者：Gemini
 * 更新时间：2024-05-03
 * * [脚本说明]
 * 1. 本脚本用于定时汇总查询多个学生的作业历史。
 * 2. 必须配合重写脚本 (yiqizuoye_get_cookie.js) 使用以自动获取身份令牌。
 * 3. 运行原理：从 $prefs 中根据姓名读取对应的 Cookie，模拟 App 发送 HTTPS 请求。
 * * [多学生调用逻辑]
 * - 脚本会自动循环 CONFIG.studentNames 数组中的名字。
 * - 每一个名字会对应本地存储中的一个 Key，如: yiqizuoye_cookie_yihan。
 * - 如果某个学生的 Cookie 失效，脚本会单独针对该学生发出重登提醒。
 * * [配置参考]
 * [task_local]
 * 30 18 * * * yiqizuoye_task.js, tag=17作业汇总, enabled=true
 * ==========================================
 */

const CONFIG = {
    // 对应 $prefs 中存储的后缀名，脚本会循环调用这里的每个人名
    studentNames: ["yihan", "yibo"], 
    url: "https://www.17zuoye.com/studentMobile/homework/homework/typehistory.vpage?app_version=3.8.31.1066&page=1&newHomeworkTypes=Normal%2COCR%2CCustomize",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 17Student iOS 3.8.31.1066"
};

/**
 * 格式化日期显示，增加星期几
 */
function formatStartDate(dateStr) {
    if (!dateStr) return "未知日期";
    const match = dateStr.match(/(\d+)月(\d+)日/);
    if (!match) return dateStr;
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const currentYear = new Date().getFullYear();
    const dateObj = new Date(currentYear, month - 1, day);
    const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const weekDay = weekDays[dateObj.getDay()];
    return `${month}月${day}日(${weekDay})`;
}

/**
 * 核心函数：根据学生姓名获取对应的 Cookie 并查询作业
 */
async function fetchHomework(name) {
    // 根据传入的名字动态拼接存储 Key
    const saveKey = `yiqizuoye_cookie_${name}`;
    const cookie = $prefs.valueForKey(saveKey);

    if (!cookie) {
        const msg = `【${name}】：未找到本地 Cookie，请先登录 App 获取`;
        console.log(`⚠️ ${msg}`);
        return msg;
    }

    console.log(`🚀 正在请求 ${name} 的作业数据...`);
    const req = {
        url: CONFIG.url,
        method: "GET",
        headers: {
            "Cookie": cookie,
            "User-Agent": CONFIG.userAgent
        }
    };

    try {
        const resp = await $task.fetch(req);
        const json = JSON.parse(resp.body);

        // 判断是否有有效数据或是否被拦截到登录页
        if (!json.homeworkHistory || !json.homeworkHistory.content) {
            const errMsg = `【${name}】：Cookie已失效，请重新登录 App 获取`;
            // 只有在失败时才发出重获通知
            $notify("17作业提醒", `学生: ${name}`, "Cookie 失效，请重新获取");
            return errMsg;
        }

        const content = json.homeworkHistory.content;
        if (content.length === 0) return `【${name}】：暂无作业记录`;

        const list = content.map(i => {
            const formattedDate = formatStartDate(i.startDate);
            const score = i.homeworkScore ?? "未完成";
            return `${formattedDate} | ${i.unitNames} | ${score}`;
        }).join("\n");

        return `【${name}】\n${list}`;
    } catch (e) {
        return `【${name}】：请求失败(${e.message})`;
    }
}

/**
 * 主程序：汇总所有学生的结果
 */
async function main() {
    console.log("--- 📝 开始执行作业汇总查询 ---");
    try {
        // 使用 Promise.all 并行处理 CONFIG.studentNames 数组中的所有人
        const results = await Promise.all(CONFIG.studentNames.map(name => fetchHomework(name)));
        const finalMessage = results.join("\n\n----------------\n\n");
        
        console.log("\n--- 📋 最终汇总结果 ---\n");
        console.log(finalMessage);

        // 发送最终的汇总通知
        $notify("📚 作业汇总查询", `查询时间: ${new Date().toLocaleString()}`, finalMessage);
    } catch (e) {
        $notify("❌ 脚本出错", "", e.message);
    } finally {
        $done();
    }
}

main();
