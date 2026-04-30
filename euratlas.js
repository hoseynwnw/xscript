/**
 * Quantumult X 脚本：删除 Euratlas 广告区块
 * 匹配目标：所有 id="box_pub" 的 div 元素
 */

let body = $response.body;

if (body) {
    // 正则表达式解析：
    // <div[^>]* : 匹配 <div 开头及其后的任意非 > 字符
    // id="box_pub" : 必须包含 id="box_pub"
    // [^>]*> : 匹配剩余的属性并闭合标签
    // [\s\S]*? : 非贪婪匹配内部所有字符（包括换行符）
    // <\/div> : 匹配闭合的 </div>
    // g : 全局匹配，确保删除页面上所有出现该 ID 的区块
    const adRegex = /<div[^>]*id="box_pub"[^>]*>[\s\S]*?<\/div>/g;
    
    body = body.replace(adRegex, '');
    
    console.log("Euratlas Ad-Blocker: Successfully removed box_pub elements.");
}

$done({ body });
