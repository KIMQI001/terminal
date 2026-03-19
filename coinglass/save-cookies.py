from curl_cffi import requests
import json

session = requests.Session(impersonate="chrome")

# 1. 先访问主页
print("1. 访问主页...")
resp = session.get("https://www.coinglass.com")

# 2. 登录
print("2. 登录...")
login_data = {
    "mailAddress": "297511521@qq.com",
    "password": "123456lzy"
}

resp = session.post(
    "https://capi.coinglass.com/coin-community/api/user/login",
    data=login_data,
    headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.coinglass.com",
        "Referer": "https://www.coinglass.com/"
    }
)

result = resp.json()
print(f"   成功: {result.get('success')}")

if result.get('success'):
    token = result['data']['accessToken']

    # 保存 cookies 为 JSON 格式
    cookies_list = []
    for name, value in session.cookies.items():
        cookies_list.append({
            "name": name,
            "value": value,
            "domain": ".coinglass.com",
            "path": "/"
        })

    with open('cookies.json', 'w') as f:
        json.dump(cookies_list, f, indent=2)

    print(f"\nCookies 已保存到 cookies.json")
    print(f"Token: {token}")
