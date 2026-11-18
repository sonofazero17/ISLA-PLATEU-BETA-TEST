# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/uploads_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, zlib, struct
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3954; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT","MAIL_","SMTP_","CAPTCHA_"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026", TRUST_PROXY_HOPS="1")
def png(path, rgb, w=160, h=100):
    raw=b"".join(b"\x00"+bytes(rgb)*w for _ in range(h))
    def ch(t,d): c=struct.pack(">I",len(d))+t+d; return c+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    open(path,"wb").write(b"\x89PNG\r\n\x1a\n"+ch(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b""))
for n,c in (("logo",(200,90,40)),("cover",(40,140,90)),("food",(60,90,200)),("food2",(190,160,40))): png(f"{D}/{n}.png",c)
open(D+"/bad.svg","w").write("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
ctr=[0]
def api(method,path,body=None,cj=None):
    ctr[0]+=1; op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    rq=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={"Content-Type":"application/json","X-Forwarded-For":f"10.4.0.{ctr[0]&255}"})
    try:
        r=op.open(rq); t=r.read(); return r.status,json.loads(t)
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
def login(portal,email,pw):
    cj=http.cookiejar.CookieJar(); s,d=api("POST","/api/login",{"portal":portal,"email":email,"password":pw},cj); assert s==200,(s,d)
    return cj,[c for c in cj if c.name=="isla_sid"][0].value
errors=[]; results=[]
def check(c,name): results.append(c); print(("PASS " if c else "FAIL ")+name)
try:
    acj,_=login("ADMINISTRATOR","admin@islaplateu.local","Smoke-Test-2026")
    api("POST","/api/admin/restaurants",{"name":"Upload Test Grill","municipality":"Larena","category":"Restaurant","address":"Larena","lat":9.2,"lng":123.52},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Up Staff","email":"up@example.com","restaurantId":"upload-test-grill"},acj); scj,ssid=login("RESTAURANT_STAFF","up@example.com",d["temporaryPassword"])
    api("POST","/api/staff/menu",{"name":"Plain Rice","price":40},scj); s,m=api("GET","/api/staff/menu",cj=scj)
    api("PATCH",f"/api/staff/menu/{m[0]['id']}",{"available":False},scj); api("PATCH","/api/staff/restaurant",{"acceptsOrders":True},scj)
    api("POST","/api/register",{"fullName":"Cara Customer","email":"cara@example.com","password":"Island2026","confirmPassword":"Island2026"}); ccj,csid=login("CUSTOMER","cara@example.com","Island2026")
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page(sid=None,w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h},extra_http_headers={"X-Forwarded-For":"10.4.9.%d"%(w%200)})
            if sid: ctx.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}])
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        loaded=lambda pg,sel: pg.evaluate("(s) => { const i = document.querySelector(s); return !!i && i.complete && i.naturalWidth > 0; }", sel)
        sp=page(ssid); sp.goto(BASE+"/staff"); sp.click("[data-tab=restaurant]"); sp.locator("[data-img-upload='/api/staff/restaurant/logo']").wait_for(state="attached")
        sp.set_input_files("[data-img-upload='/api/staff/restaurant/logo']",D+"/logo.png"); sp.locator(".toast", has_text="Image saved").first.wait_for(); sp.locator(".img-preview.logo img").wait_for()
        check(loaded(sp,".img-preview.logo img"),"staff upload a logo and see the preview (a real image)")
        sp.set_input_files("[data-img-upload='/api/staff/restaurant/cover']",D+"/cover.png"); sp.locator(".img-preview.cover img").wait_for(); check(loaded(sp,".img-preview.cover img"),"staff upload a profile/cover image")
        sp.set_input_files("[data-img-upload='/api/staff/restaurant/logo']",D+"/bad.svg"); sp.locator(".toast", has_text="Only JPG").first.wait_for(); check(True,"an SVG upload is refused with a clear message")
        sp.fill("#mName","Grilled Tuna"); sp.fill("#mPrice","250"); sp.fill("#mCat","Seafood"); sp.set_input_files("#mImg",D+"/food.png"); sp.click("#menuForm button[type=submit]")
        sp.locator(".toast", has_text="Menu item added").first.wait_for(); sp.locator("img.food-thumb").wait_for(); ok_=False
        for _ in range(25):
            if loaded(sp,"img.food-thumb"): ok_=True; break
            time.sleep(0.2)
        check(ok_ and "Seafood" in sp.inner_text("#restRoot"),"staff add a food item with category and photo; the thumbnail loads")
        sp.set_input_files("[data-img-upload^='/api/staff/menu/']:not([data-img-upload*='logo'])",D+"/food2.png"); sp.locator(".toast", has_text="Image saved").first.wait_for(); check(True,"staff replace a food photo")
        sp.screenshot(path=SHOTS+"/staff_images.png",full_page=True)
        cp=page(csid); cp.goto(BASE+"/map"); cp.locator("[data-details=upload-test-grill]").wait_for(); cp.wait_for_load_state("networkidle")
        check(loaded(cp,".restaurant-avatar img"),"customers see the uploaded logo as the restaurant's avatar on the map list")
        cp.locator("[data-details=upload-test-grill]").click(); cp.locator(".detail-cover").wait_for(); cp.locator(".menu-card").first.wait_for(); cp.wait_for_load_state("networkidle")
        check(loaded(cp,".detail-cover") and loaded(cp,".detail-logo"),"the details panel shows the cover image and logo")
        check(loaded(cp,".menu-card img") and "Grilled Tuna" in cp.inner_text(".menu-cards") and "Available" in cp.inner_text(".menu-cards"),"the menu shows the food photo, name, price and availability")
        check("Unavailable" in cp.inner_text(".menu-cards"),"an unavailable item is shown as unavailable (and cannot be ordered)")
        cp.screenshot(path=SHOTS+"/customer_images.png")
        cp.locator("[data-act=order]").click(); cp.locator(".order-list li").first.wait_for(); check(cp.locator(".order-list li").count()==1 and cp.locator(".order-thumb").count()==1,"the order window lists only available items, with their photos")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
