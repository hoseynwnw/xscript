const script = `
  (function() {
    const el = document.getElementById('box_pub');
    if (el) {
      el.remove(); 
      console.log('box_pub has been deleted');
    }
  })();
`;

// 将这段 JS 注入到 </body> 标签之前
const jsTag = `<script>${script}</script>`;
const bodyRegex = /<\/body>/i;

if ($response.body) {
    let body = $response.body;
    if (bodyRegex.test(body)) {
        body = body.replace(bodyRegex, jsTag + '</body>');
        $done({ body });
    } else {
        $done({ body });
    }
} else {
    $done({});
}
