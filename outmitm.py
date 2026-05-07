import json
import sys
from mitmproxy import io, http  # 关键：导入 http 模块
from mitmproxy.exceptions import FlowReadException

def flow_to_dict(flow):
    """
    将一个 flow 转换为普通字典。
    """
    # 过滤：如果不是 HTTP 流量（例如是 DNS），则直接返回 None
    if not isinstance(flow, http.HTTPFlow):
        return None

    d = {
        "id": flow.id,
        "type": "http",
        "timestamp": flow.timestamp_start,
        "request": {
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "headers": dict(flow.request.headers),
            "content": flow.request.get_text(strict=False),
        },
        "response": None,
        "error": None,
    }
    
    if flow.response:
        d["response"] = {
            "status_code": flow.response.status_code,
            "headers": dict(flow.response.headers),
            "content": flow.response.get_text(strict=False),
        }
    if flow.error:
        d["error"] = flow.error.msg
    return d

def convert(input_file, output_file):
    flows = []
    with open(input_file, "rb") as f:
        reader = io.FlowReader(f)
        for flow in reader.stream():
            try:
                # 转换流量
                flow_data = flow_to_dict(flow)
                # 只有当它是 HTTP 流量时才加入列表
                if flow_data is not None:
                    flows.append(flow_data)
            except FlowReadException:
                pass

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(flows, f, indent=2, ensure_ascii=False)
    
    print(f"转换完成！共提取到 {len(flows)} 条 HTTP 记录。")

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法: python mitm.py <输入.mitm> <输出.json>")
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
