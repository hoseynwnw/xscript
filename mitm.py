import json
from mitmproxy import http

def response(flow: http.HTTPFlow):
    # 拿到当前的 URL
    url = flow.request.pretty_url
    
    # ================= 模块 1: 清空文章列表 =================
    if "ksnapi/article/list" in url:
        try:
            data = json.loads(flow.response.get_text())
            data["data"]["list"] = []
            flow.response.set_text(json.dumps(data))
            print(f"\n[🚀 拦截成功] 已清空文章列表")
        except Exception as e:
            print(f">>> ❌ 文章列表修改出错: {e}")

    # ================= 模块 4: 你想加的新东西写在这里 =================
    # 以后每增加一个，就复制下面这段格式：
    if "abengine/api/client" in url:
        try:
            data = json.loads(flow.response.get_text())
            data["data"]["ab"] = []
            # 修改代码写这里...
            flow.response.set_text(json.dumps(data))
            print(f"\n[🚀 拦截成功] 新接口处理完成")
        except Exception as e:
            print(f">>> ❌ 新接口修改出错: {e}")            
    # ================= 模块 3: 我的商城购买清空 ==p===============
    # 以后每增加一个，就复制下面这段格式：
    if "ksnapi/knowledge/ucenter" in url:
        try:
            data = json.loads(flow.response.get_text())
            data["data"]["specialRegion"]["list"] = []
            # 修改代码写这里..
            flow.response.set_text(json.dumps(data))
            print(f"\n[🚀 拦截成功] 新接口处理完成")
        except Exception as e:
            print(f">>> ❌ 新接口修改出错: {e}")            
