from curl_cffi import requests
import json

session = requests.Session(impersonate="chrome")

# 1. 先访问主页获取初始 cookies
print("1. 访问主页...")
resp = session.get("https://www.coinglass.com")
print(f"   状态: {resp.status_code}")

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

print(f"   状态: {resp.status_code}")
result = resp.json()
print(f"   成功: {result.get('success')}")

if result.get('success'):
    token = result['data']['accessToken']
    print(f"   Token: {token[:20]}...")

    # 3. 用 token 访问需要认证的页面获取 cookies
    print("3. 访问清算地图...")
    resp = session.get(
        "https://www.coinglass.com/pro/futures/LiquidationMap?exchange=Binance&symbol=BTC",
        headers={
            "Authorization": f"Bearer {token}"
        }
    )
    print(f"   状态: {resp.status_code}")

    # 4. 获取 cookies
    print("\n4. Cookies:")
    for k, v in session.cookies.items():
        print(f"   {k}: {v[:30]}..." if len(str(v)) > 30 else f"   {k}: {v}")

    # 5. 保存 cookies
    import pickle
    with open('cookies.json', 'wb') as f:
        pickle.dump(dict(session.cookies), f)
    print("\nCookies 已保存到 cookies.json")
