/**
 * 脚本名称：隐藏指定HTML元素
 * 适用域名：www.euratlas.net
 * 功能：在页面加载前注入CSS，隐藏 ID 为 box_pub 的元素
 */

const css = '<style>#box_pub { display: none !important; }</style>';

// 使用正则表达式匹配 <body> 标签，不区分大小写，且兼容带属性的 body 标签
const bodyRegex = /<body[^>]*>/i;

if ($response.body) {
    let body = $response.body;
    
    // 如果找到了 <body> 标签，就在其后插入 CSS
    if (bodyRegex.test(body)) {
        body = body.replace(bodyRegex, (match) => match + css);
        $done({ body });
    } else {
        // 如果没找到 body 标签，原样返回
        $done({ body });
    }
} else {
    // 如果没有响应体，原样返回
    $done({});
}
