/**
 * Quantumult X 脚本：自动获取 17作业 Cookie
 * 配置：重写 (Rewrite) 类型
 */

const url = $request.url;
const headerCookie = $request.headers["Cookie"] || $request.headers["cookie"];

// 定义存储 Key 映射逻辑 (根据 URL 参数或请求体识别学生，这里简单通过 UID 区分)
// 你也可以根据登录时捕获的 uid 来动态决定存入哪个账号
const uidMatch = headerCookie ? headerCookie.match(/uid=(\d+)/) : null;

if (headerCookie && uidMatch) {
    const uid = uidMatch[1];
    // 你可以根据 UID 映射到具体的姓名，或者直接以 UID 存
    // 这里演示以 "yihan" 或 "yibo" 存储，你可以根据实际 UID 修改判断逻辑
    let studentName = "";
    if (uid === "3171269283") studentName = "yihan";
    if (uid === "3173157116") studentName = "yibo";

    if (studentName) {
        const saveKey = `yiqizuoye_cookie_${studentName}`;
        if ($prefs.setValueForKey(headerCookie, saveKey)) {
            $notify("17作业", `成功获取 ${studentName} 的 Cookie`, "数据已更新，查询脚本将自动使用新 Cookie");
            console.log(`[17作业] 已更新 ${studentName} 的 Cookie: ${headerCookie}`);
        }
    } else {
        // 如果不在预设名单，则按 UID 存储
        $prefs.setValueForKey(headerCookie, `yiqizuoye_cookie_${uid}`);
        console.log(`[17作业] 捕获到未定义名称的 UID: ${uid}`);
    }
}

$done({});
