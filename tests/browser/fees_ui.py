# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/fees_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, datetime, zlib, struct
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3949; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
PNG=b"\x89PNG\r\n\x1a\n"+b"1"*200
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
    api("POST","/api/admin/restaurants",{"name":"Fee Test Grill","municipality":"Larena","category":"Restaurant","address":"Larena","acceptsReservations":True,"lat":9.2,"lng":123.52},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Fee Staff","email":"fee@example.com","restaurantId":"fee-test-grill"},acj)
    scj,ssid=login("RESTAURANT_STAFF","fee@example.com",d["temporaryPassword"])
    api("POST","/api/staff/menu",{"name":"Grilled Tuna","price":250},scj); api("PATCH","/api/staff/restaurant",{"acceptsOrders":True},scj)
    api("PUT","/api/staff/payment-account",{"holderName":"Juan Dela Cruz","mobile":"09171234567"},scj)
    api("POST","/api/staff/payment-account/qr",cj=scj,raw=PNG,ctype="image/png")
    api("PUT","/api/staff/payment-account",{"holderName":"Juan Dela Cruz","mobile":"09171234567","orderPrepay":True,"reservationFee":50},scj)
    api("POST","/api/register",{"fullName":"Cara Customer","email":"cara@example.com","password":"Island2026","confirmPassword":"Island2026"})
    ccj,csid=login("CUSTOMER","cara@example.com","Island2026")
    day=(datetime.date.today()+datetime.timedelta(days=3)).isoformat()
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page_for(sid,w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h}); ctx.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}])
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        ap=page_for(asid); ap.goto(BASE+"/admin"); ap.click("[data-tab=fees]"); ap.locator("#feeRoot", has_text="Nothing is charged until you add it").wait_for()
        check("No service fee or system tax is configured" in ap.inner_text("#feeRoot"),"admin sees an empty configuration and the warning that nothing is charged by default")
        ap.click("[data-fee-edit=new]"); ap.fill("#flLabel","ISLA-PLATEU service fee"); ap.select_option("#flCalc","PERCENT"); ap.fill("#flVal","5"); ap.select_option("#flBase","RESTAURANT_TOTAL"); ap.click("[data-yes]")
        ap.locator(".toast", has_text="Saved").first.wait_for(); ap.locator("#feeRoot tbody tr").first.wait_for(); check(ap.locator("#feeRoot tbody tr").count()==1,"admin adds a service fee line")
        ap.click("[data-fee-edit=new]"); ap.select_option("#flKind","SYSTEM_TAX"); ap.fill("#flLabel","Sample system tax"); ap.fill("#flVal","10"); ap.select_option("#flBase","SERVICE_FEES")
        check(not ap.locator("#flVerWrap").is_hidden(),"choosing a tax reveals the verification checkbox")
        ap.click("[data-yes]"); ap.locator(".form-alert", has_text="basis").wait_for(); check(True,"a tax cannot be saved without its legal or accounting basis")
        ap.fill("#flNote","Sample basis text for testing"); ap.click("[data-yes]"); ap.locator(".form-alert", has_text="verified").wait_for(); check(True,"…nor without the explicit verification")
        ap.check("#flVer"); ap.click("[data-yes]"); ap.locator(".toast", has_text="Saved").first.wait_for(); ap.locator("#feeRoot tbody tr").nth(1).wait_for(); check(ap.locator("#feeRoot tbody tr").count()==2,"verified tax line saved")
        check("Verified" in ap.locator("#feeRoot tbody tr").nth(1).inner_text(),"the tax row shows when it was verified")
        ap.select_option("#pvRest","fee-test-grill"); ap.fill("#pvAmount","250"); ap.click("#pvGo"); ap.locator("#pvOut .breakdown").wait_for()
        pv=ap.inner_text("#pvOut").lower(); check("isla-plateu service fee" in pv and "government taxes" in pv and "total payable" in pv,"admin preview shows separated sections and a total")
        ap.screenshot(path=SHOTS+"/admin_fees.png",full_page=True)
        sp=page_for(ssid); sp.goto(BASE+"/staff"); sp.click("[data-tab=payments]"); sp.locator("#chAdd").wait_for()
        sp.fill("#chLabel","Service charge"); sp.fill("#chValue","10"); sp.click("#chAdd"); sp.locator(".toast", has_text="Charge added").first.wait_for()
        check("Service charge" in sp.inner_text("#payRoot") and "Restaurant fee" in sp.inner_text("#payRoot"),"staff add their own service charge")
        sp.select_option("#chKind","TAX"); sp.fill("#chLabel","Sample VAT"); sp.fill("#chValue","12"); sp.click("#chAdd"); sp.locator("#chAlert", has_text="registered or authorised").wait_for(); check(True,"staff must confirm before adding a tax")
        cp=page_for(csid); cp.goto(BASE+"/map"); cp.locator("[data-details=fee-test-grill]").click(); cp.locator("[data-act=order]").click()
        cp.locator(".order-list li").first.wait_for(); cp.locator("[data-step='1']").first.click(); cp.fill("#orDate",day); cp.fill("#orTime","12:30")
        cp.click("[data-go=review]"); cp.locator(".breakdown").wait_for()
        t=cp.inner_text(".modal, dialog[open]")
        tl=t.lower(); check("restaurant charges" in tl and "service charge" in tl and "isla-plateu service fee" in tl and "sample system tax" in tl and "government taxes" in tl,"order review separates restaurant charges, taxes and the ISLA-PLATEU fee")
        check("total payable" in tl and "not a government tax" in tl,"review states the total payable and that the platform fee is not a tax")
        cp.screenshot(path=SHOTS+"/customer_breakdown.png")
        cp.click("[data-go=place]"); cp.locator("img.pay-qr").wait_for(timeout=8000)
        check("Total payable" in cp.inner_text(".modal, dialog[open]") and "ISLA-PLATEU service fee" in cp.inner_text(".modal, dialog[open]"),"payment window repeats the same breakdown")
        cp.click("[data-no]")
        cp.goto(BASE+"/map"); cp.locator("[data-details=fee-test-grill]").click(); cp.locator("[data-act=reserve]").click(); cp.locator("#rvFee .breakdown").wait_for()
        check("Reservation fee" in cp.inner_text("#rvFee") and "Total payable" in cp.inner_text("#rvFee"),"the reservation dialog shows the fee breakdown before sending")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
