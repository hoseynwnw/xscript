/**
 * 作业帮合规接口重写
 * 功能：关闭常规推送，激活黑名单与核心商业屏蔽
 */

let body = $response.body;
let obj = JSON.parse(body);

// 确保逻辑仅在存在目标字段时执行
if (obj.data) {
    // 1. 修改 filter: 1 -> 0
    if (obj.data.hasOwnProperty('filter')) {
        obj.data.filter = 0;
    }
    
    // 2. 修改 isBlackFilter: 0 -> 1
    if (obj.data.hasOwnProperty('isBlackFilter')) {
        obj.data.isBlackFilter = 1;
    }
    
    // 3. 修改 isCoreBlack: 0 -> 1
    if (obj.data.hasOwnProperty('isCoreBlack')) {
        obj.data.isCoreBlack = 1;
    }
}

$done({ body: JSON.stringify(obj) });
