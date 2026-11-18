(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const steps = { email: $("stepEmail"), code: $("stepCode"), password: $("stepPassword"), success: $("stepSuccess") };
  const banner = $("banner");
  let accountEmail = "";
  let resendInterval = null;

  function showStep(name) {
    Object.entries(steps).forEach(([key, element]) => { element.hidden = key !== name; });
    banner.className = "form-banner alert hidden";
    banner.textContent = "";
    if (window.ISLA) ISLA.refreshIcons();
  }
  function message(kind, text) {
    banner.className = `form-banner alert alert-${kind}`;
    banner.textContent = text;
  }
  function busy(button, busy, label) {
    button.disabled = busy;
    if (label) button.textContent = busy ? "Please wait…" : label;
  }
  function startResendCooldown(seconds) {
    clearInterval(resendInterval);
    const button = $("resendCode"), timer = $("resendTimer");
    let left = Math.max(0, Number(seconds) || 60);
    const draw = () => {
      button.disabled = left > 0;
      timer.textContent = left > 0 ? `(${left}s)` : "";
    };
    draw();
    if (left > 0) resendInterval = setInterval(() => { left -= 1; draw(); if (left <= 0) clearInterval(resendInterval); }, 1000);
  }
  async function requestCode(isResend) {
    const button = isResend ? $("resendCode") : $("emailForm").querySelector("button[type=submit]");
    busy(button, true, isResend ? "Resend Code" : "Continue");
    const result = await ISLA.api(isResend ? "/api/password-recovery/resend" : "/api/password-recovery/request", { body: { email: accountEmail } });
    busy(button, false, isResend ? "Resend Code" : "Continue");
    if (result.ok) {
      if (!isResend) {
        $("sentTo").textContent = `Verification email requested for ${accountEmail}`;
        showStep("code");
        startResendCooldown(60);
      } else {
        message("success", "If an account matches that email address, a new verification code will be sent shortly.");
        startResendCooldown(60);
      }
      return;
    }
    message("error", result.data.error || "We couldn't process your request. Please try again.");
    if (isResend && result.data.retryAfter) startResendCooldown(result.data.retryAfter);
  }

  $("emailForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/i.test(email)) {
      message("error", "Enter the Gmail address associated with your ISLA-PLATEU account.");
      $("email").focus();
      return;
    }
    accountEmail = email;
    await requestCode(false);
  });

  $("codeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("verificationCode").value.replace(/\D/g, "").slice(0, 6);
    $("verificationCode").value = code;
    if (!/^\d{6}$/.test(code)) { message("error", "Enter the six-digit verification code from your email."); return; }
    const button = $("codeForm").querySelector("button[type=submit]");
    busy(button, true, "Verify");
    const result = await ISLA.api("/api/password-recovery/verify", { body: { email: accountEmail, code } });
    busy(button, false, "Verify");
    if (result.ok) {
      clearInterval(resendInterval);
      showStep("password");
      $("newPassword").focus();
    } else message("error", result.data.error || "The verification code is invalid or has expired.");
  });

  $("verificationCode").addEventListener("input", () => {
    $("verificationCode").value = $("verificationCode").value.replace(/\D/g, "").slice(0, 6);
  });
  $("resendCode").addEventListener("click", () => requestCode(true));
  $("changeEmail").addEventListener("click", () => {
    clearInterval(resendInterval);
    $("verificationCode").value = "";
    showStep("email");
    $("email").focus();
  });

  $("passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("newPassword").value;
    const confirmPassword = $("confirmPassword").value;
    document.querySelectorAll("[data-error-for]").forEach((node) => { node.textContent = ""; });
    if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      document.querySelector('[data-error-for="password"]').textContent = "Use 8 to 128 characters, including at least one letter and one number.";
      return;
    }
    if (password !== confirmPassword) {
      document.querySelector('[data-error-for="confirmPassword"]').textContent = "Your passwords do not match.";
      return;
    }
    const button = $("passwordForm").querySelector("button[type=submit]");
    busy(button, true, "Save Password");
    const result = await ISLA.api("/api/password-recovery/complete", { body: { password, confirmPassword } });
    busy(button, false, "Save Password");
    if (result.ok) showStep("success");
    else {
      message("error", result.data.error || "Your password could not be changed. Please try again.");
      if (result.status === 401) { showStep("email"); message("error", result.data.error || "Your verification has expired. Start again."); }
      if (result.data.fields) Object.entries(result.data.fields).forEach(([key, text]) => {
        const node = document.querySelector(`[data-error-for="${key}"]`); if (node) node.textContent = text;
      });
    }
  });

  document.querySelectorAll(".toggle-pw").forEach((button) => button.addEventListener("click", () => {
    const input = $(button.dataset.target), showing = input.type === "password";
    input.type = showing ? "text" : "password";
    button.setAttribute("aria-pressed", String(showing));
    button.setAttribute("aria-label", showing ? "Hide password" : "Show password");
    button.innerHTML = `<i data-lucide="${showing ? "eye-off" : "eye"}" class="icon"></i>`;
    ISLA.refreshIcons();
  }));
})();
