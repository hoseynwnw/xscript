//https://script.google.com/home/starred  
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var texts = params.texts || [];
    var targetLang = params.targetLang || 'zh-CN';
    var sourceLang = params.sourceLang || '';

    if (texts.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ translations: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1. 防吞噬處理：避免空字串導致分隔符號被合併
    for (var i = 0; i < texts.length; i++) {
      if (!texts[i] || texts[i].trim() === "") {
        texts[i] = " "; // 強制佔位
      }
    }

    // 換用更穩定的管道符號
    var delimiter = "\n\n ||| \n\n";
    var combinedText = texts.join(delimiter);
    
    var translatedText = "";
    var maxRetries = 3;
    for (var r = 0; r < maxRetries; r++) {
      try {
        translatedText = LanguageApp.translate(combinedText, sourceLang, targetLang);
        break;
      } catch (apiErr) {
        if (r === maxRetries - 1) throw apiErr;
        Utilities.sleep(1500);
      }
    }

    // 容錯切割：包含全角丨的可能
    var translatedArray = translatedText.split(/\s*\|\|\|\s*|\s*丨丨丨\s*/);

    // 2. 終極急救機制：如果長度依然不符，直接在 GAS 內部切換為逐句精準翻譯！
    if (translatedArray.length !== texts.length) {
      translatedArray = [];
      for (var j = 0; j < texts.length; j++) {
        if (texts[j] === " ") {
          translatedArray.push("");
        } else {
          // 逐句翻譯雖然稍慢，但能保證 100% 絕對對齊
          translatedArray.push(LanguageApp.translate(texts[j], sourceLang, targetLang));
        }
      }
    }

    // 清理空白
    for (var k = 0; k < translatedArray.length; k++) {
      translatedArray[k] = (translatedArray[k] || "").trim();
    }

    return ContentService.createTextOutput(JSON.stringify({ translations: translatedArray }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
