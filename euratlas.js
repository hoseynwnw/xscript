/**
 * @name Delete Box Pub
 * @description 彻底从源码删除 #box_pub 元素
 */

// 匹配 <div id="box_pub"> 到最近的 </div> 结束标签
// [^]*? 是为了匹配包含换行符在内的所有字符（非贪婪）
const regex = /<div id="box_pub">[^]*?<\/div>/i;

if ($response.body) {
    let body = $response.body;
    if (regex.test(body)) {
        // 将匹配到的整个 div 块替换为空字符串
        body = body.replace(regex, "");
        $done({ body });
    } else {
        $done({ body });
    }
} else {
    $done({});
}
