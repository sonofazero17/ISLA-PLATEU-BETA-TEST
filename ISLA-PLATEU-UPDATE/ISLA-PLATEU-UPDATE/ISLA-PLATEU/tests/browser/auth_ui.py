# Browser test (needs Python Playwright: pip install playwright && playwright install chromium). Run: python3 tests/browser/auth_ui.py
import subprocess, os, time, json, tempfile, urllib.request, http.cookiejar, threading, socketserver, base64, re, http.server, urllib.parse
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","..")); PORT=3950; BASE=f"http://localhost:{PORT}"; D=tempfile.mkdtemp(); SHOTS=os.environ.get("SHOTS_DIR", os.path.join(tempfile.gettempdir(), "isla-shots")); os.makedirs(SHOTS, exist_ok=True)
# ---- fake SMTP
MAILS=[]
class SMTP(socketserver.StreamRequestHandler):
    def handle(self):
        w=lambda s: self.wfile.write((s+"\r\n").encode()); w("220 fake")
        data=False; lines=[]; cur={}
        while True:
            raw=self.rfile.readline()
            if not raw: break
            line=raw.decode().rstrip("\r\n")
            if data:
                if line==".": data=False; cur["raw"]="\r\n".join(lines); MAILS.append(cur); cur={}; lines=[]; w("250 ok")
                else: lines.append(line)
                continue
            u=line.upper()
            if u.startswith("EHLO"): w("250-fake"); w("250 AUTH PLAIN")
            elif u.startswith("AUTH"): w("235 ok")
            elif u.startswith("MAIL FROM"): w("250 ok")
            elif u.startswith("RCPT TO"): cur["to"]=re.search(r"<([^>]*)>",line).group(1); w("250 ok")
            elif u=="DATA": data=True; w("354 go")
            elif u=="QUIT": w("221 bye"); break
            else: w("250 ok")
def code_for(to):
    for m in reversed(MAILS):
        if m.get("to")==to:
            t=re.search(r"Content-Type: text/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n(.*?)\r\n\r\n--",m["raw"],re.S)
            return re.search(r"code is: (\d{6})",base64.b64decode(t.group(1).replace("\r\n","")).decode()).group(1)
class Reuse(socketserver.ThreadingTCPServer): allow_reuse_address=True; daemon_threads=True
smtp=Reuse(("127.0.0.1",0),SMTP); threading.Thread(target=smtp.serve_forever,daemon=True).start()
# ---- fake captcha verify
USED=set()
class Cap(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        body=urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("Content-Length",0))).decode()); tok=(body.get("response") or [""])[0]
        ok=tok.startswith("ok") and tok not in USED and (body.get("secret") or [""])[0]=="test-secret"
        if ok: USED.add(tok)
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(json.dumps({"success":ok,"error-codes":[] if ok else ["timeout-or-duplicate"]}).encode())
cap=http.server.ThreadingHTTPServer(("127.0.0.1",0),Cap); threading.Thread(target=cap.serve_forever,daemon=True).start()
env={k:v for k,v in os.environ.items() if not k.startswith(("NODE_ENV","ADMIN_","DB_PATH","PORT","MAIL_","SMTP_","CAPTCHA_"))}
env.update(PORT=str(PORT), DB_PATH=D+"/t.db", ADMIN_PASSWORD="Smoke-Test-2026", TRUST_PROXY_HOPS="1", MAIL_PROVIDER="smtp", SMTP_HOST="127.0.0.1", SMTP_PORT=str(smtp.server_address[1]), SMTP_SECURE="none", SMTP_USER="u", SMTP_PASS="p", MAIL_FROM="ISLA-PLATEU <no-reply@isla.test>", CAPTCHA_SITE_KEY="site", CAPTCHA_SECRET_KEY="test-secret", CAPTCHA_VERIFY_URL=f"http://127.0.0.1:{cap.server_address[1]}/v")
srv=subprocess.Popen(["node","server.js"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT); time.sleep(2.5)
FAKE_SCRIPT="window.turnstile={render:function(el,o){var b=document.createElement('button');b.type='button';b.className='fake-captcha';b.textContent='I am human';b.onclick=function(){o.callback('ok-'+Math.random().toString(36).slice(2));b.textContent='Verified'};el.appendChild(b);return 1},reset:function(){document.querySelectorAll('.fake-captcha').forEach(function(b){b.textContent='I am human'})}};"
errors=[]; results=[]
def check(c,name): results.append(c); print(("PASS " if c else "FAIL ")+name)
def api(method,path,body=None):
    rq=urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={"Content-Type":"application/json","X-Forwarded-For":"10.7.7.7"})
    try:
        r=urllib.request.urlopen(rq); t=r.read(); return r.status,json.loads(t)
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read())
try:
    with sync_playwright() as p:
        b=p.chromium.launch()
        def page(w=1280,h=900,ip="10.2.2.2"):
            ctx=b.new_context(viewport={"width":w,"height":h},extra_http_headers={"X-Forwarded-For":ip}); pg=ctx.new_page()
            pg.route("**/*",lambda r: r.fulfill(status=200,content_type="application/javascript",body=FAKE_SCRIPT) if "challenges.cloudflare.com" in r.request.url else (r.continue_() if r.request.url.startswith(BASE) else r.abort()))
            pg.on("pageerror",lambda e: errors.append("PAGEERR "+str(e))); pg.on("console",lambda m: errors.append("CONSOLE: "+m.text) if ("Refused" in m.text or "Content Security" in m.text) else None); return pg
        # --- customer registration with CAPTCHA + code
        pg=page(ip="10.3.3.3"); pg.goto(BASE+"/register"); pg.locator(".fake-captcha").wait_for()
        check(True,"the CAPTCHA widget loads on the registration page (the policy allows the provider's script)")
        pg.fill("[name=fullName]","Cara Customer"); pg.fill("[name=email]","cara@example.com"); pg.fill("[name=password]","Island2026"); pg.fill("[name=confirmPassword]","Island2026")
        pg.click("button[type=submit]"); pg.locator(".form-banner", has_text="security check").wait_for(); check(True,"submitting without the CAPTCHA is stopped with a clear message")
        pg.click(".fake-captcha"); pg.click("button[type=submit]"); pg.locator(".verify-panel").wait_for()
        check(pg.locator("#form-register").is_hidden() and "cara@example.com" in pg.inner_text(".verify-text"),"after registering, the form is replaced by the code step showing the address")
        time.sleep(0.5); code=code_for("cara@example.com"); check(bool(code),"the code was emailed")
        pg.screenshot(path=SHOTS+"/verify_panel.png")
        pg.fill(".verify-code","12ab34"); check(pg.input_value(".verify-code")=="1234","the code box accepts digits only")
        pg.fill(".verify-code","000000" if code!="000000" else "111111"); pg.click(".verify-btn"); pg.locator(".verify-msg", has_text="4 attempts left").wait_for(); check(True,"a wrong code shows how many attempts remain")
        check(pg.locator(".verify-resend-btn").is_disabled() and "ask for another code" in pg.inner_text(".verify-timer"),"the resend button is disabled with a countdown after the first email")
        pg.fill(".verify-code",code); pg.click(".verify-btn"); pg.locator(".verify-msg", has_text="verified").wait_for()
        pg.wait_for_url("**/login?verified=1**",timeout=8000); pg.locator(".form-banner", has_text="Email verified").first.wait_for(); check(True,"the right code verifies and sends the person to login with a success message")
        pg.fill("#form-customer [name=email]","cara@example.com") if pg.locator("#form-customer").count() else None
        # --- unverified login shows the code step
        s,d=api("POST","/api/register",{"fullName":"Dan Customer","email":"dan@example.com","password":"Island2026","confirmPassword":"Island2026","captchaToken":"ok-seed-1"})
        check(s==201 and d["needsVerification"],"(setup) second account registered via the API")
        pg2=page(ip="10.4.4.4"); pg2.goto(BASE+"/login"); pg2.locator("#form-customer [name=email]").fill("dan@example.com"); pg2.locator("#form-customer [name=password]").fill("Island2026"); pg2.locator("#form-customer button[type=submit]").click()
        pg2.locator(".verify-panel").wait_for(); check("not verified yet" in pg2.inner_text(".verify-text") and "verify your email" in pg2.inner_text("#form-customer .form-banner").lower(),"logging in before verifying shows the reason and the code step")
        pg2.locator(".verify-resend-btn").wait_for(); pg2.click(".verify-resend-btn"); pg2.locator(".verify-msg", has_text="security check").wait_for(); check(True,"asking for a new code requires the CAPTCHA first")
        pg2.click(".verify-captcha .fake-captcha"); pg2.click(".verify-resend-btn"); pg2.locator(".verify-msg", has_text="wait").wait_for(timeout=8000); check(True,"…and the one-per-minute limit is explained")
        pg2.fill(".verify-code",code_for("dan@example.com")); pg2.click(".verify-btn"); pg2.locator("#form-customer .form-banner", has_text="Email verified").wait_for(timeout=8000); check(True,"entering the code there verifies the account without leaving the page")
        # --- login CAPTCHA after failures
        pg3=page(ip="10.5.5.5"); pg3.goto(BASE+"/login")
        for i in range(3):
            pg3.locator("#form-customer [name=email]").fill("cara@example.com"); pg3.locator("#form-customer [name=password]").fill("WrongPass%d"%i); pg3.locator("#form-customer button[type=submit]").click(); pg3.locator("#form-customer .form-banner", has_text="Incorrect").wait_for()
        check(pg3.locator("#form-customer .fake-captcha").count()==0,"no CAPTCHA is shown for the first wrong passwords")
        pg3.locator("#form-customer [name=password]").fill("WrongPass9"); pg3.locator("#form-customer button[type=submit]").click(); pg3.locator("#form-customer .fake-captcha").wait_for()
        check("security check" in pg3.inner_text("#form-customer .form-banner").lower() and pg3.input_value("#form-customer [name=password]")=="WrongPass9","after three failures the CAPTCHA appears and what was typed is kept")
        pg3.screenshot(path=SHOTS+"/login_captcha.png")
        pg3.locator("#form-customer [name=password]").fill("Island2026"); pg3.click("#form-customer .fake-captcha"); pg3.locator("#form-customer button[type=submit]").click(); pg3.wait_for_url("**/map**",timeout=8000); check(True,"solving it and entering the right password logs in")
        # --- staff application
        pg4=page(ip="10.6.6.6"); pg4.goto(BASE+"/register-staff"); pg4.locator(".fake-captcha").wait_for(); check(True,"the CAPTCHA also protects the staff application")
        s,_=api("GET","/api/config"); check(s==200,"config reachable")
        b.close()
finally:
    srv.kill(); smtp.shutdown(); cap.shutdown()
print("errors:",errors); check(not errors,"no JS or CSP errors")
print(f"\n{sum(results)} passed, {len(results)-sum(results)} failed")
