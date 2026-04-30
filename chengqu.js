/**
 * XPlan Skin Unlocker for Quantumult X
 * 功能：解锁所有皮肤 + 强制启动皮肤 + 伪造应用成功


# XPlan 皮肤全解锁 + 强制启动 (包含列表、详情和应用接口)
^https?:\/\/appserver\.nokeeu\.com\/api\/user\/a\/v1\/skin\/(suggestSkinList|useSkin|getCurrentSkinDetail) url script-response-body https://raw.githubusercontent.com/hoseynwnw/xscript/main/chengqu.js

[mitm]
hostname = appserver.nokeeu.com

 */

// ==============================================================================
// ⚙️ 配置中心
// ==============================================================================

// 可选皮肤列表: "Bluebeach", "BlueHour", "brilliant", "peach", "1Bit", "glacier", "starfield", "blackgold"
const SELECTED_SKIN_NO = "brilliant"; 

// 公共字段：所有皮肤共用的属性
const DEFAULT_FIELDS = {
    "marketServiceFee": 0.0,
    "saleServiceFee": 0.0,
    "symbol": "￥",
    "supportTryFlag": 1,
    "tryUseDays": null,
    "tryUseDuration": null,
    "tryUseUnit": 1,
    "buyPrice": null,
    "keepStatus": 3,
    "tag": "已拥有"
};

// 皮肤数据库：只保留唯一属性
const SKIN_DATABASE = {
    "Bluebeach": { "skinId": 101, "skinName": "晴空海岸", "skinDesc": "以湛蓝天空与细腻海岸为底色...", "skinCoverImgUrl": "https://p1.nokeeu.com/carmodel/7b63d671c9784063974a4ca74566ede8.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/BlueBeach.zip", "fileMd5": "9e984816c88e2f29c953635fd66e5432", "skinImgList": ["https://p1.nokeeu.com/carmodel/a54831c5e46142a4bbd0e38cdccd225e.png"] },
    "BlueHour": { "skinId": 102, "skinName": "蓝调时刻", "skinDesc": "背景以渐变的暮色星空为基调...", "skinCoverImgUrl": "https://p1.nokeeu.com/carmodel/000578bd6df847f0b97b1cf4d5c299cd.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/BlueHour (2).zip", "fileMd5": "f74a95368f48fe955b73d32ca1ce9321", "skinImgList": ["https://p1.nokeeu.com/carmodel/ed7b367e93a341baad3f26cd0e2c098e.png"] },
    "brilliant": { "skinId": 103, "skinName": "璀璨辉金", "skinDesc": "璀璨的金色熠熠生辉...", "skinCoverImgUrl": "https://p1.nokeeu.com/app-skin/img/brilliant_gold_main.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/Brilliant2.zip", "fileMd5": "0e7ddad69b1eda9c83490161e8f6b18c", "skinImgList": ["https://p1.nokeeu.com/app-skin/img/brilliant_gold_img_1.png", "https://p1.nokeeu.com/app-skin/img/brilliant_gold_img_2.png"] },
    "peach": { "skinId": 104, "skinName": "水蜜桃", "skinDesc": "闭上眼睛品尝...", "skinCoverImgUrl": "https://p1.nokeeu.com/app-skin/img/peach_main.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/peach.zip", "fileMd5": "1acefe83d67a0c8f176624ce82bf9940", "skinImgList": ["https://p1.nokeeu.com/app-skin/img/peach_img_v1.png", "https://p1.nokeeu.com/app-skin/img/peach_img_v2.png"] },
    "1Bit": { "skinId": 105, "skinName": "1BIT", "skinDesc": "还记得那个捧着GameBoy...", "skinCoverImgUrl": "https://p1.nokeeu.com/app-skin/img/1Bit_main.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/1Bit.zip", "fileMd5": "919b08bfd2b0f57e9e2d13b03a5ac2cd", "skinImgList": ["https://p1.nokeeu.com/app-skin/img/1Bit_img_v1.png", "https://p1.nokeeu.com/app-skin/img/1Bit_img_v2.png"] },
    "glacier": { "skinId": 106, "skinName": "冰川", "skinDesc": "如同一座沉睡的蓝色巨兽...", "skinCoverImgUrl": "https://p1.nokeeu.com/app-skin/img/glacier_main.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/glacier.zip", "fileMd5": "2bf3c25f7f3bc76c6833d1c526738c55", "skinImgList": ["https://p1.nokeeu.com/app-skin/img/glacier_img_v1.png", "https://p1.nokeeu.com/app-skin/img/glacier_img_v2.png"] },
    "starfield": { "skinId": 107, "skinName": "星球", "skinDesc": "灵感来自年度热门游戏...", "skinCoverImgUrl": "https://p1.nokeeu.com/app-skin/img/starfield_main.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/starfield-idea-2.zip", "fileMd5": "1723d5341065b67fa6972c5dc97a6c93", "skinImgList": ["https://p1.nokeeu.com/app-skin/img/starfield_img_v1.png", "https://p1.nokeeu.com/app-skin/img/starfield_img_v2.png"] },
    "blackgold": { "skinId": 108, "skinName": "臻享黑金", "skinDesc": "低调而尊贵...", "skinCoverImgUrl": "https://p1.nokeeu.com/app-skin/img/black_main.png", "fileDownUrl": "https://p1.nokeeu.com/app-skin/blackgold-idea-2.zip", "fileMd5": "0b3e81bba9476ce70fdc6e179172d7b4", "skinImgList": ["https://p1.nokeeu.com/app-skin/img/black_img_v1.png", "https://p1.nokeeu.com/app-skin/img/black_img_v2.png"] },
};

// ==============================================================================

const url = $request.url;
let body = $response.body;

if (body) {
    try {
        let obj = JSON.parse(body);

        // 场景 A: 启动同步 (getCurrentSkinDetail) -> 强制启动皮肤
        if (url.indexOf("/api/user/a/v1/skin/getCurrentSkinDetail") !== -1) {
            if (obj.code === 0) {
                const skinInfo = SKIN_DATABASE[SELECTED_SKIN_NO] || SKIN_DATABASE["brilliant"];
                obj.data = { ...DEFAULT_FIELDS, ...skinInfo, "skinNo": SELECTED_SKIN_NO, "usingFlag": 1 };
                console.log(`QuanX: 强制启动皮肤 -> ${skinInfo.skinName}`);
            }
        } 
        
        // 场景 B: 建议列表 (suggestSkinList) -> 伪造全拥有
        else if (url.indexOf("/api/user/a/v1/skin/suggestSkinList") !== -1) {
            if (obj.data && Array.isArray(obj.data)) {
                obj.data.forEach(skin => {
                    Object.assign(skin, DEFAULT_FIELDS);
                });
                console.log("QuanX: 皮肤列表已伪造为全拥有");
            }
        } 
        
        // 场景 C: 应用皮肤 (useSkin) -> 强制成功响应
        else if (url.indexOf("/api/user/a/v1/skin/useSkin") !== -1) {
            if (obj.code !== 0) {
                obj.code = 0;
                obj.message = "成功";
                obj.data = obj.data || {};
                console.log("QuanX: 应用响应已强制改为成功");
            }
        }

        body = JSON.stringify(obj);
    } catch (e) {
        console.log("QuanX Skin Error: " + e);
    }
}

$done({ body });
