
/**
 * 作业帮 多接口数据修改脚本
 */

let url = $request.url;
let body = $response.body;

try {
    let obj = JSON.parse(body);

    // 模块 1: 清空文章列表
    if (url.indexOf("ksnapi/article/list") > -1) {
        if (obj.data && obj.data.list) {
            obj.data.list = [];
            console.log("[🚀 拦截成功] 已清空文章列表");
        }
    }

    // 模块 2: 清空 AB 测试配置
    else if (url.indexOf("abengine/api/client") > -1) {
        if (obj.data && obj.data.ab) {
            obj.data.ab = [];
            console.log("[🚀 拦截成功] 已清空 AB 列表");
        }
    }

    // 模块 3: 清空商城购买/个人中心列表
    else if (url.indexOf("ksnapi/knowledge/ucenter") > -1) {
        if (obj.data && obj.data.specialRegion && obj.data.specialRegion.list) {
            obj.data.specialRegion.list = [];
            console.log("[🚀 拦截成功] 已清空个人中心特殊列表");
        }
    }

    body = JSON.stringify(obj);
} catch (e) {
    console.log(">>> ❌ 脚本执行出错: " + e);
}

$done({ body });
