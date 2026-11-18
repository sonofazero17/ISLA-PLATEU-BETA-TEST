# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/orders_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, datetime
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3947; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
def api(method,path,body=None,cj=None,raw=None,ctype="application/json"):
    op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    rq=urllib.request.Request(BASE+path,data=data,method=method,headers={"Content-Type":ctype} if data is not None else {})
    try:
        r=op.open(rq); t=r.read(); return r.status,(json.loads(t) if t[:1] in b"{[" else t)
    except urllib.error.HTTPError as e:
        t=e.read(); return e.code,(json.loads(t) if t[:1] in b"{[" else t)
def login(portal,email,pw):
    cj=http.cookiejar.CookieJar(); s,d=api("POST","/api/login",{"portal":portal,"email":email,"password":pw},cj); assert s==200,(s,d)
    return cj,[c for c in cj if c.name=="isla_sid"][0].value
errors=[]; results=[]
def check(c,name): results.append(c); print(("PASS " if c else "FAIL ")+name)
try:
    acj,asid=login("ADMINISTRATOR","admin@islaplateu.local","Smoke-Test-2026")
    api("POST","/api/admin/restaurants",{"name":"Order Test Grill","municipality":"Larena","category":"Restaurant","address":"Larena","lat":9.2,"lng":123.52},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Ord Staff","email":"ord@example.com","restaurantId":"order-test-grill"},acj)
    scj,ssid=login("RESTAURANT_STAFF","ord@example.com",d["temporaryPassword"])
    s,a=api("POST","/api/staff/menu",{"name":"Grilled Tuna","price":250,"description":"Fresh catch","category":"Seafood"},scj)
    s,b2=api("POST","/api/staff/menu",{"name":"Garlic Rice","price":40},scj)
    api("POST",f"/api/staff/menu/{a['id']}/image",cj=scj,raw=b"\x89PNG\r\n\x1a\n"+b"1"*200,ctype="image/png")
    api("PATCH","/api/staff/restaurant",{"acceptsOrders":True,"orderDineIn":True},scj)
    api("POST","/api/register",{"fullName":"Cara Customer","email":"cara@example.com","password":"Island2026","confirmPassword":"Island2026"})
    ccj,csid=login("CUSTOMER","cara@example.com","Island2026")
    day=(datetime.date.today()+datetime.timedelta(days=2)).isoformat()
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page_for(sid,w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h}); ctx.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}])
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        cp=page_for(csid); cp.goto(BASE+"/map"); cp.locator("[data-details=order-test-grill]").click()
        cp.locator("[data-act=order]").click(); cp.locator(".order-list li").nth(1).wait_for()
        check(cp.locator(".order-list img.order-thumb").count()==1,"order dialog shows the food photo")
        cp.locator("[data-step='1'][data-id='%d']"%a["id"]).click(); cp.locator("[data-step='1'][data-id='%d']"%a["id"]).click(); cp.locator("[data-step='1'][data-id='%d']"%b2["id"]).click()
        check(cp.inner_text("#orTotal").replace(",","").endswith("540.00"),"stepper updates the live subtotal (2 x 250 + 40)")
        cp.click("[data-go=review]"); cp.locator(".form-alert", has_text="date and time").wait_for(); check(True,"review requires a date and time")
        cp.locator("input[name=orFul][value=DINE_IN]").check(); check("Arrival" in cp.inner_text("#orDateL"),"choosing dine-in relabels the time fields as Arrival")
        cp.fill("#orDate",day); cp.fill("#orTime","12:30"); cp.fill("#orNotes","No chili please")
        cp.click("[data-go=review]"); cp.locator("h3", has_text="Review your order").wait_for()
        rv=cp.inner_text(".modal, dialog[open]")
        check("2 × Grilled Tuna" in rv and "1 × Garlic Rice" in rv and "Dine-in" in rv and "540.00" in rv and "No chili please" in rv,"review step shows lines, service, time, note and the server-priced total")
        cp.screenshot(path=SHOTS+"/order_review.png")
        cp.click("[data-go=back]"); cp.locator("#q%d"%a["id"]).wait_for(); check(cp.inner_text("#q%d"%a["id"])=="2" and cp.input_value("#orNotes")=="No chili please","going back keeps the quantities and notes")
        cp.click("[data-go=review]"); cp.locator("[data-go=place]").wait_for(); cp.click("[data-go=place]")
        cp.locator(".toast", has_text="Advance order sent").first.wait_for(); check(True,"order placed")
        sp=page_for(ssid); sp.goto(BASE+"/staff"); sp.click("[data-tab=orders]")
        card=sp.locator("#ordList .item-card").first; card.wait_for()
        check("dine-in" in card.inner_text() and "Grilled Tuna" in card.inner_text(),"staff see the order labelled dine-in")
        for label in ["Accept","Start preparing"]:
            sp.locator("#ordList button", has_text=label).first.click(); sp.locator("#ordList button", has_text="Start preparing" if label=="Accept" else "Mark ready").first.wait_for()
        check(True,"staff accept and start preparing")
        ap=page_for(csid); ap.goto(BASE+"/account"); ap.click("[data-tab=orders]"); ap.locator("#ordList .tracker").wait_for()
        cur=ap.locator("#ordList .tracker li.current").inner_text()
        check("Preparing" in cur,"customer tracker shows Preparing as the current step")
        ap.screenshot(path=SHOTS+"/order_tracker.png",full_page=True)
        sp.locator("#ordList button", has_text="Cancel order").first.click(); sp.locator("textarea").fill("Kitchen ran out of tuna"); sp.locator("[data-yes]").click()
        sp.locator(".toast", has_text="Order updated").first.wait_for()
        ap.reload(); ap.click("[data-tab=orders]"); ap.locator("#ordList .tracker-end").wait_for()
        check("ran out of tuna" in ap.inner_text("#ordList"),"customer sees the cancellation and the reason")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
