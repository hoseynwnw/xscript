//https://script.google.com/home/starred  
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var texts = params.texts || [];
    // 支援以逗號分隔的多個語言，例如 'zh-CN,fa'
    var targetLangParam = params.targetLang || 'zh-CN'; 
    var sourceLang = params.sourceLang || '';

    if (texts.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ translations: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1. 防吞噬處理：佔位符
    for (var i = 0; i < texts.length; i++) {
      if (!texts[i] || texts[i].trim() === "") texts[i] = " ";
    }

    var delimiter = "\n\n ||| \n\n";
    var combinedText = texts.join(delimiter);
    
    // 將目標語言拆分為陣列
    var targetLangs = targetLangParam.split(',').map(function(l) { return l.trim(); });
    var multiLangResults = []; // 儲存各個語言的翻譯陣列

    // 2. 針對每個語言循環呼叫 Google 內網翻譯
    for (var langIdx = 0; langIdx < targetLangs.length; langIdx++) {
      var tLang = targetLangs[langIdx];
      var translatedText = "";
      var maxRetries = 3;
      
      for (var r = 0; r < maxRetries; r++) {
        try {
          translatedText = LanguageApp.translate(combinedText, sourceLang, tLang);
          break;
        } catch (apiErr) {
          if (r === maxRetries - 1) throw apiErr;
          Utilities.sleep(1500);
        }
      }

      var translatedArray = translatedText.split(/\s*\|\|\|\s*|\s*丨丨丨\s*/);

      // 急救機制
      if (translatedArray.length !== texts.length) {
        translatedArray = [];
        for (var j = 0; j < texts.length; j++) {
          if (texts[j] === " ") {
            translatedArray.push("");
          } else {
            translatedArray.push(LanguageApp.translate(texts[j], sourceLang, tLang));
          }
        }
      }

      // 智慧排版：判斷當前這層語言是否為 RTL (由右至左)
      var rtlLangs = ['ar', 'he', 'fa', 'ur'];
      var isRtl = false;
      for (var rl = 0; rl < rtlLangs.length; rl++) {
        if (tLang.indexOf(rtlLangs[rl]) === 0) { isRtl = true; break; }
      }

      for (var k = 0; k < translatedArray.length; k++) {
        var cleanStr = (translatedArray[k] || "").trim();
        // 如果是 RTL 語言，單獨為這行字套上 \u202B 控制符
        if (isRtl && cleanStr !== "") {
          cleanStr = "\u202B" + cleanStr + "\u202C";
        }
        translatedArray[k] = cleanStr;
      }
      
      multiLangResults.push(translatedArray);
    }

    // 3. 將多個語言的陣列垂直合併
    var finalTranslations = [];
    for (var i = 0; i < texts.length; i++) {
      var combinedLine = [];
      for (var l = 0; l < multiLangResults.length; l++) {
        if (multiLangResults[l][i] !== "") {
          combinedLine.push(multiLangResults[l][i]);
        }
      }
      // 用換行符將中文、波斯文等拼在一起
      finalTranslations.push(combinedLine.join("\n"));
    }

    return ContentService.createTextOutput(JSON.stringify({ translations: finalTranslations }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
