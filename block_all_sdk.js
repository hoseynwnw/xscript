// ===============================
// 日志开关（true=显示日志，false=不显示）
// ===============================
const ENABLE_LOG = true;

// ===============================
// 工具函数：打印日志（受开关控制）
// ===============================
function log(msg) {
    if (ENABLE_LOG) console.log(msg);
}

// ===============================
// 自动识别 SDK 路径 → 返回对应正确响应格式
// ===============================

let url = $request.url;

// 命中输出函数
function hit(name, body) {
    log(`[HIT] 命中：${name}`);
    log(`[URL] ${url}`);
    log(`[RETURN] ${body}`);
    $done({ body });
}

// 穿山甲 Pangle / GroMore
if (url.includes("/service/2/app_log")) {
    hit("Pangle app_log", '{"err_no":0,"message":"success"}');
    return;
}

// Sentry envelope
if (url.includes("/api/2/envelope")) {
    hit("Sentry envelope", "");
    return;
}

// 友盟 Umeng
if (url.includes("/unify_logs")) {
    hit("Umeng unify_logs", '{"success":true}');
    return;
}

// 快手 Kuaishou
if (url.includes("/rest/e/v3/open/logBatch")) {
    hit("Kuaishou logBatch", '{"result":1}');
    return;
}

// 66mobi
if (url.includes("/sdk/report/its.api")) {
    hit("66mobi its.api", '{"code":0}');
    return;
}

// YFanAds
if (url.includes("/api/v2/ads/batchUpload")) {
    hit("YFanAds batchUpload", '{"status":0}');
    return;
}

// BaiheMob
if (url.includes("/ad2")) {
    hit("BaiheMob ad2", '{"code":0}');
    return;
}

// App 自己日志
if (url.includes("/alog")) {
    hit("App alog", '{"code":0}');
    return;
}

// 默认兜底
log(`[DEFAULT] 未匹配路径 → ${url}`);
hit("Default", '{"code":0}');
