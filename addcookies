/*
脚本功能: 获取 bing面板cookie, 用于lowking脚本
操作步骤: web访问 https://rewards.bing.com 登录即可

[rewrite local]
^https?:\/\/rewards\.bing\.com url script-request-header https://raw.githubusercontent.com/MCdasheng/QuantumultX/main/Scripts/myScripts/Bing/bingPoint/bingPoint.cookie.js

[mitm]
hostname = rewards.bing.com
*/

// 1. 从请求头中提取 Cookie
const cookie = $request.headers["Cookie"] || $request.headers["cookie"];

if (cookie) {
    // 2. 直接使用 QuanX 原生 API 保存到本地存储
    $prefs.setValueForKey(cookie, "bingPointCookieKey");
    
    // 3. 打印日志到 QuanX 日志窗口
    console.log("🎉 面板cookie获取成功: " + cookie);
    
    // 4. 发出系统通知
    $notify("Bing积分", subtitle: "🎉 面板cookie获取成功", message: "现在请禁用此抓取脚本");
} else {
    console.log("❌ 未能获取到 Cookie，请重新登录");
}

// 5. 结束脚本
$done({});
