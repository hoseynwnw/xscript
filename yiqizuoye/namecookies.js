/**
 * ==========================================
 * 脚本名称：17作业汇总查询 (姓名显示版)
 * ==========================================
 */

const CONFIG = {
    INDEX_KEY: "yiqizuoye_uid_index",
    url: "https://www.17zuoye.com/studentMobile/homework/homework/typehistory.vpage?app_version=3.8.31.1066&page=1&newHomeworkTypes=Normal%2COCR%2CCustomize",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 17Student iOS 3.8.31.1066"
};

function formatStartDate(dateStr) {
    if (!dateStr) return "未知日期";
    const match = dateStr.match(/(\d+)月(\d+)日/);
    if (!match) return dateStr;
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);
    const currentYear = new Date().getFullYear();
    const dateObj = new Date(currentYear, month - 1, day);
    const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${month}月${day}日(${weekDays[dateObj.getDay()]})`;
}

async function fetchHomework(uid) {
    const cookie = $prefs.valueForKey(`yiqizuoye_cookie_${uid}`);
    const name = $prefs.valueForKey(`yiqizuoye_name_${uid}`) || uid; // 优先用姓名，没有就用 UID

    if (!cookie) return `【${name}】：本地无数据`;

    const req = {
        url: CONFIG.url,
        method: "GET",
        headers: { "Cookie": cookie, "User-Agent": CONFIG.userAgent }
    };

    try {
        const resp = await $task.fetch(req);
        const json = JSON.parse(resp.body);

        if (!json.homeworkHistory || !json.homeworkHistory.content) {
            $notify("17作业失效", `学生: ${name}`, "请重新打开 App 获取 Cookie");
            return `【${name}】：Cookie 已失效`;
        }

        const content = json.homeworkHistory.content;
        if (content.length === 0) return `【${name}】：暂无记录`;

        const list = content.map(i => {
            const date = formatStartDate(i.startDate);
            const score = i.homeworkScore ?? "未完成";
            return `${date} | ${i.unitNames} | ${score}`;
        }).join("\n");

        return `【${name}】\n${list}`;
    } catch (e) {
        return `【${name}】：请求出错`;
    }
}

async function main() {
    const indexStr = $prefs.valueForKey(CONFIG.INDEX_KEY);
    if (!indexStr) {
        $notify("17作业", "查询终止", "尚未捕获到任何学生数据");
        $done();
        return;
    }

    const uids = indexStr.split(",");
    try {
        const results = await Promise.all(uids.map(uid => fetchHomework(uid)));
        const finalMessage = results.join("\n\n----------------\n\n");
        $notify("📚 17作业汇总", `查询时间: ${new Date().toLocaleTimeString()}`, finalMessage);
    } catch (e) {
        console.log("执行失败: " + e);
    } finally {
        $done();
    }
}

main();
