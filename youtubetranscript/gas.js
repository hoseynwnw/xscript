//https://script.google.com/home/starred  
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var texts = params.texts || [];
    var targetLangParam = params.targetLang || 'zh-CN'; 
    var sourceLang = params.sourceLang || '';

    if (texts.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ translations: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    for (var i = 0; i < texts.length; i++) {
      if (!texts[i] || texts[i].trim() === "") texts[i] = " ";
    }

    var delimiter = "\n\n ||| \n\n";
    var combinedText = texts.join(delimiter);
    
    var targetLangs = targetLangParam.split(',').map(function(l) { return l.trim(); });
    var multiLangResults = []; 

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

      // --- 核心修復：為急救機制加入重試與防併發休眠 ---
      if (translatedArray.length !== texts.length) {
        translatedArray = [];
        for (var j = 0; j < texts.length; j++) {
          if (texts[j] === " ") {
            translatedArray.push("");
          } else {
            var singleTrans = "";
            for (var sr = 0; sr < 3; sr++) {
              try {
                singleTrans = LanguageApp.translate(texts[j], sourceLang, tLang);
                break;
              } catch (singleErr) {
                if (sr === 2) throw singleErr;
                Utilities.sleep(1000); // 逐句翻譯被限流時休眠 1 秒
              }
            }
            translatedArray.push(singleTrans);
          }
          // 每句間隔 50 毫秒，防止雙語 100 句瞬間併發打穿 Google 防火牆
          Utilities.sleep(50); 
        }
      }

      var rtlLangs = ['ar', 'he', 'fa', 'ur'];
      var isRtl = false;
      for (var rl = 0; rl < rtlLangs.length; rl++) {
        if (tLang.indexOf(rtlLangs[rl]) === 0) { isRtl = true; break; }
      }

      for (var k = 0; k < translatedArray.length; k++) {
        var cleanStr = (translatedArray[k] || "").trim();
        if (isRtl && cleanStr !== "") {
          cleanStr = "\u202B" + cleanStr + "\u202C";
        }
        translatedArray[k] = cleanStr;
      }
      
      multiLangResults.push(translatedArray);
    }

    var finalTranslations = [];
    for (var i = 0; i < texts.length; i++) {
      var combinedLine = [];
      for (var l = 0; l < multiLangResults.length; l++) {
        if (multiLangResults[l][i] !== "") {
          combinedLine.push(multiLangResults[l][i]);
        }
      }
      finalTranslations.push(combinedLine.join("\n"));
    }

    return ContentService.createTextOutput(JSON.stringify({ translations: finalTranslations }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
