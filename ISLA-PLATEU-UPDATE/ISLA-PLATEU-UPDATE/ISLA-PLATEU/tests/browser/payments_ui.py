# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/payments_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, datetime, zlib, struct
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3948; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026")
def png(path, rgb):
    raw=b"".join(b"\x00"+bytes(rgb)*8 for _ in range(8)); 
    def ch(t,d): c=struct.pack(">I",len(d))+t+d; return c+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    open(path,"wb").write(b"\x89PNG\r\n\x1a\n"+ch(b"IHDR",struct.pack(">IIBBBBB",8,8,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b""))
png(D+"/qr.png",(20,20,20)); png(D+"/receipt.png",(30,90,200))
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
def api(method,path,body=None,cj=None):
    op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)) if cj is not None else urllib.request.build_opener()
    rq=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={"Content-Type":"application/json"} if body is not None else {})
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
    api("POST","/api/admin/restaurants",{"name":"Pay Test Grill","municipality":"Larena","category":"Restaurant","address":"Larena","acceptsReservations":True,"lat":9.2,"lng":123.52},acj)
    s,d=api("POST","/api/admin/staff",{"fullName":"Pay Staff","email":"pay@example.com","restaurantId":"pay-test-grill"},acj)
    scj,ssid=login("RESTAURANT_STAFF","pay@example.com",d["temporaryPassword"])
    api("POST","/api/staff/menu",{"name":"Grilled Tuna","price":250},scj); api("PATCH","/api/staff/restaurant",{"acceptsOrders":True},scj)
    api("POST","/api/register",{"fullName":"Cara Customer","email":"cara@example.com","password":"Island2026","confirmPassword":"Island2026"})
    ccj,csid=login("CUSTOMER","cara@example.com","Island2026")
    day=(datetime.date.today()+datetime.timedelta(days=3)).isoformat()
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page_for(sid,w=1280,h=900):
            ctx=b.new_context(viewport={"width":w,"height":h}); ctx.add_cookies([{"name":"isla_sid","value":sid,"domain":"localhost","path":"/"}])
            pg=ctx.new_page(); pg.route("**/*",lambda r: r.continue_() if r.request.url.startswith(BASE) else r.abort())
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        sp=page_for(ssid); sp.goto(BASE+"/staff"); sp.click("[data-tab=payments]"); sp.locator("#gcName").wait_for()
        sp.fill("#gcName","Juan Dela Cruz"); sp.fill("#gcMobile","0917 123 4567"); sp.click("#gcSave"); sp.locator(".toast", has_text="Payment details saved").first.wait_for()
        check(True,"staff save GCash name and number")
        sp.set_input_files("#gcQr",D+"/qr.png"); sp.locator(".toast", has_text="QR code saved").first.wait_for(); sp.locator("img.pay-qr").wait_for()
        check(sp.locator("img.pay-qr").count()==1,"staff upload the QR code and see the preview")
        sp.check("#gcPrepay"); sp.fill("#gcFee","50"); sp.click("#gcSave"); sp.locator(".toast", has_text="Payment details saved").first.wait_for()
        check(sp.input_value("#gcFee")=="50" and sp.is_checked("#gcPrepay"),"staff turn on order payment and a PHP 50 reservation fee")
        sp.screenshot(path=SHOTS+"/staff_payments_settings.png",full_page=True)
        # customer orders
        cp=page_for(csid); cp.goto(BASE+"/map"); cp.locator("[data-details=pay-test-grill]").click(); cp.locator("[data-act=order]").click()
        cp.locator(".order-list li").first.wait_for(); cp.locator("[data-step='1']").first.click(); cp.fill("#orDate",day); cp.fill("#orTime","12:30")
        cp.click("[data-go=review]"); cp.locator("h3", has_text="Review your order").wait_for()
        check("pay with GCash" in cp.inner_text(".modal, dialog[open]"),"review step explains that GCash payment follows")
        cp.click("[data-go=place]"); cp.locator("h2, .modal-title, .modal h3", has_text="Pay with GCash").first.wait_for(timeout=8000)
        check(cp.locator("img.pay-qr").count()==1 and "Juan Dela Cruz" in cp.inner_text(".modal, dialog[open]") and "0917 ••• 4567" in cp.inner_text(".modal, dialog[open]"),"payment window shows QR, account name and masked number")
        check("250.00" in cp.inner_text(".modal, dialog[open]"),"payment window shows the amount due")
        cp.screenshot(path=SHOTS+"/customer_pay_dialog.png")
        cp.click("[data-yes]"); cp.locator(".form-alert", has_text="reference").wait_for(); check(True,"submit without a reference is refused in the window")
        cp.fill("#payRef","1234 567 890123"); cp.set_input_files("#payFile",D+"/receipt.png"); cp.click("[data-yes]")
        cp.locator(".toast", has_text="Receipt received").first.wait_for(); check(True,"customer submits the receipt")
        # staff: orders tab shows hold
        sp.goto(BASE+"/staff"); sp.click("[data-tab=orders]"); sp.locator("#ordList .item-card").first.wait_for()
        check(sp.locator("#ordList button", has_text="Accept").count()==0 and "only after its payment is accepted" in sp.inner_text("#ordList"),"order card hides Accept until the payment is accepted")
        sp.click("[data-tab=payments]"); sp.locator("[data-pay-accept]").wait_for()
        check(sp.locator("[data-pay-accept]").is_disabled(),"Accept payment stays disabled until staff confirm they checked GCash")
        check(sp.locator(".receipt-thumb").count()==1 and "1234 567 890123" in sp.inner_text("#payRoot"),"review card shows the receipt and reference")
        sp.screenshot(path=SHOTS+"/staff_payment_review.png",full_page=True)
        sp.check("[data-pay-verify]"); sp.click("[data-pay-accept]"); sp.locator(".toast", has_text="Payment accepted").first.wait_for(); check(True,"staff accept after verifying")
        sp.click("[data-tab=orders]"); sp.locator("#ordList button", has_text="Accept").first.click(); sp.locator(".toast", has_text="Order updated").first.wait_for()
        check(True,"the paid order can now be accepted")
        ap=page_for(csid); ap.goto(BASE+"/account"); ap.click("[data-tab=orders]"); ap.locator("#ordList .pay-line").wait_for()
        check("Payment accepted" in ap.inner_text("#ordList"),"customer sees Payment accepted on the order")
        # reservation fee
        cp.goto(BASE+"/map"); cp.locator("[data-details=pay-test-grill]").click(); cp.locator("[data-act=reserve]").click(); cp.wait_for_selector("#rvDate")
        check("reservation fee" in cp.inner_text(".modal, dialog[open]").lower() and "50.00" in cp.inner_text(".modal, dialog[open]"),"reserve dialog announces the fee")
        cp.fill("#rvDate",day); cp.fill("#rvTime","19:00"); cp.fill("#rvParty","2"); cp.click("[data-yes]")
        cp.locator("img.pay-qr").wait_for(timeout=8000); check(True,"reservation opens the payment window")
        cp.click("[data-no]")
        ap.goto(BASE+"/account"); ap.locator("#resList .pay-line").wait_for()
        check("Awaiting payment proof" in ap.inner_text("#resList") and ap.locator("#resList [data-pay]").inner_text()=="Pay with GCash","account offers Pay with GCash for the reservation")
        sp.click("[data-tab=reservations]"); sp.reload(); sp.click("[data-tab=reservations]"); sp.locator("#resList .item-card").first.wait_for()
        check(sp.locator("#resList button[data-status=CONFIRMED]").count()==0 and "only after its payment is accepted" in sp.inner_text("#resList"),"staff cannot confirm the table before the fee is accepted")
        b.close()
finally:
    srv.kill()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
