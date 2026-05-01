// 自动识别 SDK 路径 → 返回对应正确响应格式
// 保证 SDK 不重试、不报错、不卡死

let url = $request.url;

// 穿山甲 Pangle / GroMore
if (url.includes("/service/2/app_log")) {
    $done({ body: '{"err_no":0,"message":"success"}' });
    return;
}

// Sentry envelope
if (url.includes("/api/2/envelope")) {
    $done({ body: '' }); // Sentry 返回空 body
    return;
}

// 友盟 Umeng
if (url.includes("/unify_logs")) {
    $done({ body: '{"success":true}' });
    return;
}

// 快手 Kuaishou
if (url.includes("/rest/e/v3/open/logBatch")) {
    $done({ body: '{"result":1}' });
    return;
}

// 66mobi
if (url.includes("/sdk/report/its.api")) {
    $done({ body: '{"code":0}' });
    return;
}

// YFanAds
if (url.includes("/api/v2/ads/batchUpload")) {
    $done({ body: '{"status":0}' });
    return;
}

// BaiheMob
if (url.includes("/ad2")) {
    $done({ body: '{"code":0}' });
    return;
}

// App 自己日志
if (url.includes("/alog")) {
    $done({ body: '{"code":0}' });
    return;
}

// 默认兜底（如果你以后加新规则）
$done({ body: '{"code":0}' });
