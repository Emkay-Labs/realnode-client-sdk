/**
 * RealNode SDK v1.0
 * Plug-and-Play Biometric Trust Engine
 */

// Monkey patch removed: standard platform authenticators (FaceID/TouchID) now enabled.
export class RealNode {
    constructor(config) {
        this.apiBase = config.apiBase || (typeof window !== 'undefined' ? window.location.origin : "https://api.emkaylabs.tech");
        this.hankoApi = config.hankoApi;
        this.clientId = config.clientId || "realnode-sdk-client";
        this.companyId = config.companyId;
        this.onSuccess = config.onSuccess || (() => { });
        this.onError = config.onError || (() => { });
        this.onStatusChange = config.onStatusChange || (() => { });
        this.onLinkRequired = config.onLinkRequired || (() => { });
        this.onLoading = config.onLoading || (() => { });

        // Professional Interceptor: Inject B2B context for all SDK requests
        if (this.companyId && !window._hgFetchInterceptorAdded) {
            const originalFetch = window.fetch;
            window.fetch = async (...args) => {
                let [resource, reqConfig] = args;
                if (typeof resource === 'string' && resource.startsWith(this.apiBase)) {
                    reqConfig = reqConfig || {};
                    reqConfig.headers = reqConfig.headers || {};
                    reqConfig.headers['X-RN-Company-ID'] = this.companyId;
                }
                return originalFetch(resource, reqConfig);
            };
            window._hgFetchInterceptorAdded = true;
        }

        this.isVerifying = false;
        this.pulseInterval = null;
        this.hankoElement = null;

        // Lightweight debounce: track last click time per button text
        this._lastClickTime = {};

        this.currentIdh = null;
        this.registrationStarted = false; // Maria Audit: Guard flag
        this._realtimeActive = false;
        this._syncInterval = null;
        this._lastKnownRemaining = null;
        this._sseSource = null;
    }

    async init(hankoElement) {
        try {
            await this._initializeHanko(hankoElement);
            const restored = await this.restoreSession();
            return restored;
        } catch (e) {
            console.log("[STATUS] Identity protocol active.");
            this.onError(e);
            return false;
        }
    }

    async reinit() {
        console.log("[STATUS] Security protocol re-initialization...");
        window.__hankoRegisterPromise = null;
        window._hankoInitialized = false;
        if (this.hankoElement) {
            this.hankoElement._hgListenerAdded = false;
            return await this.init(this.hankoElement);
        }
        return false;
    }

    async _initializeHanko(hankoElement) {
        this.hankoElement = hankoElement;
        try {
            this.onStatusChange("[PENDING] INITIALIZING");
            const proxyUrl = `${this.apiBase}/hanko-proxy`;

            // Ensure register() is only called once.
            if (!window.__hankoRegisterPromise) {
                this._log = (msg) => { if (window.RN_DEBUG) console.log(`[AUDIT] ${msg}`); };
                window.__hankoRegisterPromise = (async () => {
                    const { register } = await import("/sdk/elements.js");
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("Hanko Registration Timeout")), 30000)
                    );
                    // Pro Hardening: Filter allowed methods at the engine level
                    await Promise.race([register(proxyUrl, { methods: ["passkey", "password"] }), timeoutPromise]);
                    window._hankoInitialized = true;
                })();
            }

            await window.__hankoRegisterPromise;

            // Prioritize passwordless/passkeys and block legacy email passcode
            hankoElement.setAttribute("passwordless", "true");
            hankoElement.setAttribute("experimental-passcode", "false");

            // Avoid adding multiple listeners if init is called multiple times on the same element
            if (!hankoElement._hgListenerAdded) {
                // PRIMARY LISTENER: CamelCase (Standard)
                hankoElement.addEventListener("onAuthFlowCompleted", (e) => this._handleAuthFlow(e));

                // SECONDARY LISTENER: Kebab-case (Fallback/Compat)
                hankoElement.addEventListener("hanko-auth-flow-completed", (e) => {
                    this._handleAuthFlow(e);
                });

                hankoElement._hgListenerAdded = true;
            }

            // INJECT ELITE CSS & START MONITORING
            this._injectHankoStyles(hankoElement);
            this._startNoticeMonitor(hankoElement);

            // SAFETY NET: Start aggressive polling for session cookie
            // If events fail, this ensures we STILL detect the login
            this._startSessionPolling();

        } catch (e) {
            this.onStatusChange("[ERROR] INITIALIZATION_FAILED");
            window.__hankoRegisterPromise = null;
        }
    }

    _injectHankoStyles(hankoElement) {
        if (!hankoElement.shadowRoot) {
            setTimeout(() => this._injectHankoStyles(hankoElement), 100);
            return;
        }

        const style = document.createElement('style');
        style.textContent = `
            .hg-btn-processing { 
                pointer-events: none !important; 
                opacity: 0.6 !important; 
                filter: grayscale(0.5) !important;
                cursor: wait !important;
            }
            button:active { transform: scale(0.98); }
            @keyframes hg-quota-flash {
                0% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0.4); background: rgba(0, 255, 136, 0.1); }
                50% { box-shadow: 0 0 20px 10px rgba(0, 255, 136, 0.6); background: rgba(0, 255, 136, 0.3); }
                100% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0); background: transparent; }
            }
            .hg-quota-restored { 
                animation: hg-quota-flash 0.8s ease-out 2 !important;
                border-color: #00ff88 !important;
                color: #fff !important;
            }
        `;
        hankoElement.shadowRoot.appendChild(style);

        // Also inject into main head for the remaining-badge which is outside shadow DOM
        if (!document.getElementById('hg-global-styles')) {
            const globalStyle = document.createElement('style');
            globalStyle.id = 'hg-global-styles';
            globalStyle.textContent = `
                @keyframes hg-quota-flash {
                    0% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0.4); background: rgba(0, 255, 136, 0.1); }
                    50% { box-shadow: 0 0 20px 10px rgba(0, 255, 136, 0.6); background: rgba(0, 255, 136, 0.3); }
                    100% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0); background: transparent; }
                }
                .hg-quota-restored { 
                    animation: hg-quota-flash 1s ease-out 2 !important;
                    border-color: #00ff88 !important;
                    color: #fff !important;
                }
            `;
            document.head.appendChild(globalStyle);
        }
    }


    _startNoticeMonitor(hankoElement) {
        const check = () => {
            if (!hankoElement.shadowRoot) return;
            const root = hankoElement.shadowRoot;
            const isRegScreen = root.querySelector('.hanko_registration') ||
                root.textContent.includes('Create a Passkey') ||
                root.textContent.includes('biometric');

            let notice = document.querySelector('.uv-security-notice');

            if (isRegScreen) {
                if (!notice) {
                    notice = document.createElement('div');
                    notice.className = 'uv-security-notice';
                    notice.style = 'margin-bottom: 1.5rem; text-align: center; animation: fadeIn 0.5s ease;';
                    notice.innerHTML = `
                        <span style="font-size: 0.65rem; color: var(--primary-cyan); letter-spacing: 2px; text-transform: uppercase; font-weight: 800; border: 1px solid rgba(0, 255, 136, 0.3); padding: 0.5rem 1rem; border-radius: 4px; background: rgba(0, 255, 136, 0.05); display: inline-block; animation: pulse 2s infinite;">
                            [REQUIRED] TWO-STEP BIOMETRIC VERIFICATION FOR ACCESS
                        </span>
                    `;
                    hankoElement.parentNode.insertBefore(notice, hankoElement);
                }
            } else if (notice) {
                notice.remove();
            }

            // Auto-fallback timer intentionally removed:
            // A prior "QR Fallback" timer was auto-clicking "other methods" after 3.5s,
            // which terminated the WebAuthn/Passkey credential creation flow mid-flight
            // and caused the "auto-back to email" bug.
            // The SDK must wait silently for the user/authenticator to complete the ceremony.
        };

        if (this.noticeInterval) clearInterval(this.noticeInterval);
        this.noticeInterval = setInterval(check, 1000);
    }


    async restoreSession() {
        try {
            const headers = {};
            if (window.RN_CONFIG && window.RN_CONFIG.apiKey) {
                headers["X-RealNode-API-Key"] = window.RN_CONFIG.apiKey;
            }
            const res = await fetch(`${this.apiBase}/check-session`, { headers });
            if (!res || !res.ok) return false;

            const data = await res.json();
            if (!data || (data.status !== "restored" && data.status !== "authorized")) return false;

            this.onStatusChange("[SUCCESS] PROFILE_ACTIVE");
            this.onSuccess({
                status: String(data.status),
                remaining: Number(data.remaining ?? 0),
                max_limit: Number(data.max_limit ?? 0)
            });
            this.currentIdh = String(data.idh);
            this._lastKnownRemaining = Number(data.remaining ?? 0);

            // Start real-time sync (SSE with Polling fallback)
            this._startSync();

            return true;
        } catch (err) {
            return false;
        }
    }

    hardReset() {
        document.cookie.split(";").forEach((c) => {
            document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
        });
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = window.location.origin;
    }

    // Unified Control Loop: Replaced multiple intervals with a single high-efficiency observer
    _startSessionPolling() {
        if (this.sessionPollingInterval) clearInterval(this.sessionPollingInterval);
        this.sessionPollingInterval = setInterval(() => {
            if (this.isVerifying || this.isCertified) return;
            const match = document.cookie.match(/(^| )hanko=([^;]+)/);
            if (match && match[2]) {
                const parts = match[2].split('.');
                if (parts.length >= 2) {
                    try {
                        const userId = JSON.parse(atob(parts[1]))?.sub;
                        if (userId) this.startCertification(String(userId));
                    } catch (e) { }
                }
            }
        }, 800);
    }

    async _handleAuthFlow(e) {
        let userId = e.detail?.userID;

        if (!userId) {
            try {
                // Extract JWT from cookie directly for maximum reliability after flow completion
                const match = document.cookie.match(/(^| )hanko=([^;]+)/);
                if (match && match[2]) {
                    const jwt = match[2];
                    const parts = jwt.split('.');
                    if (parts.length >= 2) {
                        const payload = JSON.parse(atob(parts[1]));
                        userId = payload?.sub;
                    }
                }
            } catch (err) { }
        }

        if (userId) {
            await this.startCertification(String(userId));
        } else {
            this.onError(new Error("IDENTITY_RESOLUTION_FAILED"));
        }
    }

    _stopPolling() {
        if (this.pulseInterval) {
            clearInterval(this.pulseInterval);
            this.pulseInterval = null;
        }
    }

    async generateFingerprint() {
        const components = [
            navigator.userAgent,
            screen.width + "x" + screen.height,
            new Date().getTimezoneOffset(),
            navigator.language,
            navigator.hardwareConcurrency || "N/A"
        ].join('|');
        const msgBuffer = new TextEncoder().encode(components);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return "HG-DEVICE-" + hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12).toUpperCase();
    }

    /**
     * [UNIVERSAL SDK] Dynamically inject a full-screen biometric modal.
     * Called automatically when the client's tier is ELITE (V3).
     * No code change required on the client side.
     */
    _injectBiometricModal() {
        if (document.getElementById('hg-biometric-modal')) return; // Already injected

        const overlay = document.createElement('div');
        overlay.id = 'hg-biometric-modal';
        overlay.style.cssText = [
            'display:none',
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'background:rgba(0,0,0,0.97)',
            'backdrop-filter:blur(20px)',
            '-webkit-backdrop-filter:blur(20px)',
            'flex-direction:column',
            'align-items:center',
            'justify-content:center',
            'font-family:Inter,system-ui,sans-serif'
        ].join(';');

        overlay.innerHTML = `
            <div style="text-align:center;max-width:420px;width:90%;padding:2rem">
                <div style="font-size:0.6rem;color:#00d4ff;letter-spacing:4px;text-transform:uppercase;margin-bottom:1.5rem;">
                    RealNode &#8212; Identity Verification
                </div>
                <hanko-auth id="hg-injected-hanko" lang="en" secondary-auth="false"></hanko-auth>
                <a id="hg-modal-cancel" href="#"
                   style="display:block;margin-top:1.5rem;font-size:0.65rem;color:rgba(255,255,255,0.3);
                          text-decoration:none;text-transform:uppercase;letter-spacing:3px">
                    Cancel
                </a>
            </div>
        `;
        document.body.appendChild(overlay);

        // Wire up cancel button
        overlay.querySelector('#hg-modal-cancel').addEventListener('click', (e) => {
            e.preventDefault();
            this.hideModal();
        });

        // Store reference
        this._modal = overlay;
    }

    showModal() {
        const m = document.getElementById('hg-biometric-modal');
        if (m) { m.style.display = 'flex'; }
    }

    hideModal() {
        const m = document.getElementById('hg-biometric-modal');
        if (m) { m.style.display = 'none'; }
    }

    /**
     * Intercept a button click: show the biometric modal, then proceed on success.
     * Usage: hg.protect(document.getElementById('buyBtn'), async () => { ...your logic... });
     */
    protect(button, callback) {
        if (!button) return;
        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Show modal; on success the onSuccess callback fires and can call callback
            this._pendingCallback = callback;
            this.showModal();
            if (this._modal) {
                const hankoEl = this._modal.querySelector('#hg-injected-hanko');
                if (hankoEl && !hankoEl._hgListenerAdded) {
                    await this.init(hankoEl);
                }
            }
        });
    }

    async startCertification(hankoId) {
        this.registrationStarted = true; // Maria Audit: Trigger sensor monitor
        // ELITE PRIORITY: Pause all sync background noise to give 100% bandwidth to Auth
        if (this._syncInterval) clearInterval(this._syncInterval);
        if (this._sseSource) {
            this._sseSource.close();
            this._sseSource = null;
        }

        // VISUAL FEEDBACK: Identity check required
        this.onStatusChange("[REQUIRED] BIOMETRIC_VERIFICATION");

        if (this.isCertified) {
            console.log("[STATUS] Identity protocol active.");
            return;
        }

        if (this.isVerifying) return;
        this.isVerifying = true;

        try {
            const deviceHash = await this.generateFingerprint();
            const response = await fetch(`${this.apiBase}/verify`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    hanko_id: hankoId,
                    hanko_jwt: (document.cookie.match(/(^| )hanko=([^;]+)/) || [])[2] || null,
                    device_hash: deviceHash,
                    client_id: this.clientId,
                    device_token: localStorage.getItem("rn_device_token")
                })
            });

            const res = await response.json();
            if (!res) throw new Error("Verification failed");

            if (response.status === 200) {
                const resultData = {
                    status: res.status || "authorized",
                    hanko_id: hankoId,
                    idh: res.idh || "unknown",
                    device_hash: deviceHash,
                    remaining: res.remaining ?? 0,
                    max_limit: res.max_limit ?? 0,
                    master_code: res.master_code || null
                };
                this.currentIdh = String(res.idh);

                this.onStatusChange(res.status === "pending_enrollment" ? "[PENDING] ENROLLMENT" : "[SUCCESS] SECURITY_CLEARANCE_GRANTED");

                // CRITICAL: Stop Polling immediately on success
                if (this.sessionPollingInterval) clearInterval(this.sessionPollingInterval);
                this.isCertified = true;
                this._lastKnownRemaining = resultData.remaining;

                // Save HMAC device token securely for subsequent authorized API calls
                if (res.device_token) {
                    localStorage.setItem("rn_device_token", res.device_token);
                }

                console.log("[STATUS] Identity protocol active.");

                // Trigger success and START real-time sync
                this.onSuccess(resultData);
                this._startSync();

            } else if (response.status === 409) {
                if (res.status === "linking_required") {
                    this.onStatusChange("ID_CONFLICT");
                    this.onError(new Error("Device already linked to a profile"));
                } else {
                    const err = new Error(res.reason || res.detail || "Conflict");
                    err.status = 409;
                    this._stopPolling();
                    throw err;
                }
            } else {
                const err = new Error(res.reason || res.detail || "Protocol Error");
                err.status = response.status;
                err.remaining_attempts = res.remaining_attempts;
                err.locked_until = res.locked_until;
                throw err;
            }
        } catch (err) {
            let userMsg = err.message;
            // Hardware-only interception: Detecting Hanako compatibility errors
            if (userMsg.toLowerCase().includes("no compatible") || userMsg.toLowerCase().includes("authenticator") || userMsg.toLowerCase().includes("webauthn")) {
                userMsg = "Hardware Security Key Required for Access. Please connect your FIDO2 device.";
            }
            this.onError(err);
            this.onStatusChange(userMsg);
        } finally {

        }
    }

    async consume(quantity = 1, idh) {
        // IDH-CENTRIC PIVOT: The system now uses IDH as the primary session key
        const identityKey = idh || this.currentIdh;
        if (this.isProcessing || !identityKey) throw new Error("Action locked or ID missing");
        this.registrationStarted = true;
        try {
            const deviceHash = await this.generateFingerprint();
            const response = await fetch(`${this.apiBase}/consume`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    idh: identityKey,
                    device_hash: deviceHash,
                    client_id: this.clientId,
                    quantity: quantity,
                    timestamp: Date.now() / 1000
                })
            });

            const res = await response.json();
            if (response.status === 200) return res;
            throw new Error(res.reason || res.detail || "Consumption failed");
        } finally {

        }
    }

    async recover(masterCode) {
        this.onStatusChange("[PENDING] REVIEWING_CREDENTIALS");

        try {
            const deviceHash = await this.generateFingerprint();
            const headers = { "Content-Type": "application/json" };
            if (window.RN_CONFIG && window.RN_CONFIG.apiKey) {
                headers["X-RealNode-API-Key"] = window.RN_CONFIG.apiKey;
            }
            const response = await fetch(`${this.apiBase}/recover`, {
                method: "POST",
                headers: headers,
                body: JSON.stringify({
                    master_code: masterCode,
                    device_hash: deviceHash,
                    client_id: this.clientId,
                    timestamp: Date.now() / 1000
                })
            });

            const res = await response.json();
            if (response.status === 200) {
                this.onStatusChange("[SUCCESS] RECOVERED");
                this.onSuccess(res);
            } else {
                const err = new Error(res.reason || "Invalid Master Code");
                err.status = response.status;
                err.remaining_attempts = res.remaining_attempts;
                err.locked_until = res.locked_until;
                throw err;
            }
        } catch (err) {
            this.onError(err);
            this.onStatusChange("[ERROR] RECOVERY_FAILED");
            throw err;
        } finally {

        }
    }

    async requestRescue(email) {

        try {
            const deviceHash = await this.generateFingerprint();
            const res = await fetch(`${this.apiBase}/recovery-request`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: email,
                    device_hash: deviceHash,
                    client_id: this.clientId
                })
            });
            if (!res.ok) throw new Error("Rescue request failed");
            return await res.json();
        } finally {

        }
    }

    async requestResale(idh) {
        try {
            const deviceHash = await this.generateFingerprint();
            const res = await fetch(`${this.apiBase}/recovery-request`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    idh: idh,
                    device_hash: deviceHash,
                    client_id: this.clientId,
                    request_type: 'RESALE'
                })
            });
            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.reason || "Resale declaration failed. Conflict or server error.");
            }
            return await res.json();
        } finally {

        }
    }

    async requestQuotaExtension() {
        try {
            if (!this.currentIdh) throw new Error("No active identity session");
            const deviceHash = await this.generateFingerprint();
            const res = await fetch(`${this.apiBase}/recovery-request`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    idh: this.currentIdh,
                    device_hash: deviceHash,
                    client_id: this.clientId,
                    request_type: 'QUOTA_EXT'
                })
            });
            if (!res.ok) throw new Error("Extension request failed");
            return await res.json();
        } finally {
            // Speed up polling to 3s to detect admin approval fast
            this._startSync();
            if (!this._sseSource) { // Only if SSE is not active, speed up polling
                this._startQuotaPolling(3000);
            }
        }
    }

    async finalizeEnrollment(enrollData) {

        try {
            const deviceHash = await this.generateFingerprint();
            const response = await fetch(`${this.apiBase}/finalize-enrollment`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    hanko_id: enrollData.hanko_id,
                    device_hash: deviceHash,
                    idh: enrollData.idh,
                    master_code: enrollData.master_code,
                    client_id: this.clientId
                })
            });

            const res = await response.json();
            if (response.status === 200) {
                if (res.device_token) {
                    localStorage.setItem("rn_device_token", res.device_token);
                }
                this.onStatusChange("[SUCCESS] ENROLLMENT_FINALIZED");
                return res;
            }
            throw new Error("Finalization failed");
        } finally {

        }
    }

    async transferDevice(newHankoId) {
        this.onStatusChange("[PENDING] AUTHORIZING_TRANSFER");

        try {
            const deviceHash = await this.generateFingerprint();
            const initRes = await fetch(`${this.apiBase}/initiate-transfer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    device_hash: deviceHash,
                    new_hanko_id: newHankoId,
                    client_id: this.clientId
                })
            });

            const initData = await initRes.json();
            if (initRes.status !== 200) throw new Error(initData.reason || "Transfer denied");

            const finalizeRes = await fetch(`${this.apiBase}/finalize-transfer`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    device_hash: deviceHash,
                    old_owner: initData.old_owner,
                    new_hanko_id: initData.new_hanko_id
                })
            });

            const finalData = await finalizeRes.json();
            if (finalizeRes.status === 200) {
                this.onStatusChange("[SUCCESS] TRANSFER_COMPLETE");
                this.onSuccess(finalData);
                return finalData;
            }
            throw new Error("Transfer finalization failed");
        } finally {

        }
    }

    async listDevices(idh) {
        // IDH-CENTRIC PIVOT: Use IDH for device listing
        const identityKey = idh || this.currentIdh;
        const res = await fetch(`${this.apiBase}/list-devices?idh=${identityKey}`);
        if (!res.ok) throw new Error("List failed");
        return await res.json();
    }

    async revokeDevice(deviceHash, idh) {
        // IDH-CENTRIC PIVOT: Use IDH for device revocation
        const identityKey = idh || this.currentIdh;
        try {
            const res = await fetch(`${this.apiBase}/revoke-device`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    idh: identityKey,
                    device_hash: deviceHash,
                    client_id: this.clientId
                })
            });
            if (!res.ok) throw new Error("Revocation failed");
            return await res.json();
        } finally {

        }
    }

    // --- Admin Dashboard Methods ---

    async adminLogin(email, password) {
        try {
            const res = await fetch(`${this.apiBase}/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password })
            });
            if (!res.ok) throw new Error("Admin authentication failed");
            const data = await res.json();
            this.adminToken = data.token;
            localStorage.setItem("hg_admin_token", data.token);
            return data;
        } finally {

        }
    }

    async getAdminStats() {
        const token = this.adminToken || localStorage.getItem("hg_admin_token");
        const res = await fetch(`${this.apiBase}/admin/stats`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Failed to fetch admin stats");
        return await res.json();
    }

    async getAdminUsers() {
        const token = this.adminToken || localStorage.getItem("hg_admin_token");
        const res = await fetch(`${this.apiBase}/admin/users-list`, {
            headers: { "Authorization": `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Failed to fetch admin user list");
        return await res.json();
    }

    async adminAction(action, target) {
        const token = this.adminToken || localStorage.getItem("hg_admin_token");
        const res = await fetch(`${this.apiBase}/admin/action-secure`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ action, target })
        });
        if (!res.ok) throw new Error(`Admin action ${action} failed`);
        return await res.json();
    }

    // --- REALTIME SYNC SYSTEM (SSE + POLLING) ---

    _startSync() {
        // ELITE REALTIME: Activating high-performance push sync
        this._initSSE();
    }

    _initSSE() {
        if (this._sseSource) this._sseSource.close();
        if (this._syncInterval) clearInterval(this._syncInterval);

        try {
            this._sseSource = new EventSource(`${this.apiBase}/quota-stream`, { withCredentials: true });

            this._sseSource.onmessage = (event) => {
                const data = JSON.parse(event.data);
                const newRem = Number(data.remaining ?? 0);
                const max = Number(data.max_limit ?? 0);

                if (this._lastKnownRemaining !== null && newRem > this._lastKnownRemaining) {
                    this._triggerQuotaFlash();
                }

                this._lastKnownRemaining = newRem;
                this.onSuccess({
                    status: "authorized",
                    remaining: newRem,
                    max_limit: max,
                    idh: data.idh
                });
            };

            this._sseSource.onerror = (e) => {
                // If SSE fails (e.g. proxy blocking), fallback to polling
                if (this._sseSource) this._sseSource.close();
                this._sseSource = null;
                console.warn("[RealNode] SSE connection lost. Falling back to active polling.");
                this._startQuotaPolling(10000);
            };
        } catch (err) {
            this._startQuotaPolling(10000);
        }
    }

    _startQuotaPolling(intervalMs) {
        if (this._syncInterval) clearInterval(this._syncInterval);

        // Don't poll if SSE is active
        if (this._sseSource) return;

        this._syncInterval = setInterval(async () => {
            if (!this.currentIdh) return;

            try {
                const res = await fetch(`${this.apiBase}/check-session`);
                if (!res.ok) return;

                const data = await res.json();
                if (data && data.status === "restored") {
                    const newRem = Number(data.remaining ?? 0);
                    const max = Number(data.max_limit ?? 0);

                    // Detect Quota restored (e.g. from 0 to 7)
                    if (this._lastKnownRemaining !== null && newRem > this._lastKnownRemaining) {
                        this._triggerQuotaFlash();
                        // Slow down polling if quota is full
                        if (newRem >= max) {
                            this._startQuotaPolling(10000);
                        }
                    }

                    this._lastKnownRemaining = newRem;
                    this.onSuccess({
                        status: "authorized",
                        remaining: newRem,
                        max_limit: max,
                        idh: data.idh
                    });
                }
            } catch (e) {
                // Silently ignore polling errors
            }
        }, intervalMs);
    }

    _triggerQuotaFlash() {
        const badge = document.getElementById("remaining-badge");
        if (badge) {
            badge.classList.remove("hg-quota-restored");
            void badge.offsetWidth; // Force reflow
            badge.classList.add("hg-quota-restored");

            // Auto-cleanup after animation
            setTimeout(() => badge.classList.remove("hg-quota-restored"), 3000);
        }
    }
}

// ==========================================================
// RN_SensorMatrix — Behavioural Signal Engine (V2+)
// Ported from V2_Smart_Redemption/static/hg-client.js
// Only activated when tier === "SMART" or "ELITE".
// Completely inert for V1 (SHADOW) clients.
// ==========================================================
class RN_SensorMatrix {
    static _payload = null;
    static _isReady = false;
    static _initTimeout = null;

    static autoTrigger() {
        // Safety timeout: force ready after 3s to never block purchases
        this._initTimeout = setTimeout(() => {
            if (!this._isReady) {
                if (window.RN_DEBUG) console.warn('[RN-MATRIX] Timeout — forcing ready state');
                this._isReady = true;
                if (window.RN_V2) window.RN_V2._isPayloadReady = true;
                window.dispatchEvent(new CustomEvent('rn:v2:sensor-ready', { detail: this._payload || {} }));
            }
        }, 3000);

        const trigger = () => {
            this.collect().then(p => {
                this._payload = p;
                this._isReady = true;
                clearTimeout(this._initTimeout);
                if (window.RN_V2) window.RN_V2._isPayloadReady = true;
                window.dispatchEvent(new CustomEvent('rn:v2:sensor-ready', { detail: p }));
                if (window.RN_DEBUG) console.log('[RN-MATRIX] SensorMatrix ready.');
            }).catch(() => { /* timeout fallback handles it */ });
        };

        if (window.requestIdleCallback) {
            window.requestIdleCallback(trigger);
        } else {
            setTimeout(trigger, 500);
        }
    }

    static async collect() {
        const startTime = performance.now();
        const timeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));

        // 1. RAM Proof-of-Work (non-blocking WebWorker)
        const powPromise = new Promise((resolve) => {
            const workerCode = `self.onmessage=function(){const s=performance.now();const b=new Int32Array(12500000);let h=0;for(let i=0;i<12500000;i+=2048){b[i]=Math.random()*0xFFFFFFFF;h^=b[i];}self.postMessage({hash:h,time:performance.now()-s});};`;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
            worker.postMessage('start');
            setTimeout(() => { worker.terminate(); }, 800);
        });

        // 2. Device orientation (gyroscope)
        const gyroPromise = new Promise((resolve) => {
            if (!window.DeviceOrientationEvent) { resolve('not_available'); return; }
            let events = [];
            const handler = (e) => {
                if (e.alpha === null && e.beta === null) return;
                events.push({ a: e.alpha || 0, b: e.beta || 0 });
                if (events.length >= 3) { window.removeEventListener('deviceorientation', handler); resolve({ status: 'active', variance: events.reduce((acc, v) => acc + Math.abs(v.a), 0) }); }
            };
            window.addEventListener('deviceorientation', handler, { passive: true });
            setTimeout(() => { window.removeEventListener('deviceorientation', handler); resolve(events.length > 0 ? 'static' : 'not_available'); }, 300);
        });

        // 3. WebGL GPU signature
        const glPromise = new Promise((resolve) => {
            try {
                const gl = document.createElement('canvas').getContext('webgl');
                if (!gl) { resolve('no_webgl'); return; }
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                resolve(dbg ? { vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) } : 'webgl_available');
            } catch (e) { resolve('error'); }
        });

        const results = await Promise.all([
            Promise.race([powPromise, timeout(800)]),
            Promise.race([gyroPromise, timeout(800)]),
            Promise.race([glPromise, timeout(800)])
        ]);
        return {
            pow_hash: results[0]?.hash ?? null,
            pow_time: results[0]?.time ?? '>800',
            sensor_gyro: results[1] || 'timeout',
            webgl: results[2] || 'timeout',
            matrix_latency_ms: performance.now() - startTime
        };
    }

    // ============================================================================
    // --- V2 COMPATIBILITY LAYER ---
    // ============================================================================
    async verify() {
        // Wait for SensorMatrix if available
        if (typeof RN_SensorMatrix !== 'undefined' && !RN_SensorMatrix._isReady) {
            await new Promise(resolve => {
                const listener = () => { window.removeEventListener('rn:v2:sensor-ready', listener); resolve(); };
                window.addEventListener('rn:v2:sensor-ready', listener);
                setTimeout(resolve, 3000); // Failsafe timeout
            });
        }
        
        try {
            const deviceHash = await this.generateFingerprint();
            const sensorData = typeof RN_SensorMatrix !== 'undefined' ? RN_SensorMatrix._payload : {};
            const headers = { "Content-Type": "application/json" };
            if (window.RN_CONFIG && window.RN_CONFIG.apiKey) {
                headers["X-RealNode-API-Key"] = window.RN_CONFIG.apiKey;
            }
            const response = await fetch(`${this.apiBase}/verify-human`, {
                method: "POST",
                headers: headers,
                body: JSON.stringify({
                    idh: this.currentIdh,
                    device_hash: deviceHash,
                    sensor_matrix: sensorData,
                    client_id: this.clientId
                })
            });
            const res = await response.json();
            if (response.status === 200) {
                // Normalize V2 payload to match Universal Guide expectations
                if (res.status === 'LOCAL_SUCCESS') {
                    res.status = 'authorized';
                }
                if (!res.device_hash) {
                    res.device_hash = deviceHash;
                }
                return res;
            }
            throw new Error(res.reason || "Verification failed");
        } catch(err) {
            console.warn("[HG-SDK] V2 Verification fail-safe triggered:", err);
            // Fail open to preserve B2B client's business logic
            return { status: 'authorized', remaining: this._lastKnownRemaining || 0, max_limit: 7, device_hash: await this.generateFingerprint() };
        }
    }
}

// ==========================================================
// UNIVERSAL AUTO-INITIALIZATION (V1 / V2 / V3)
// Single snippet — server controls tier activation.
// ==========================================================
if (typeof window !== 'undefined') {
    const hgConfig = window.RN_CONFIG || {};
    const _hgApiBase = hgConfig.apiBase || window.location.origin;
    const _hgApiKey  = hgConfig.apiKey  || hgConfig.sdkKey || null;

    // --- Create the universal RealNode instance (works for all tiers) ---
    const hgInstance = new RealNode({
        apiBase:  _hgApiBase,
        clientId: hgConfig.clientId || 'hg-universal-client',
        onSuccess: (data) => {
            if (window.RN_DEBUG) console.log('[RealNode] Trust session active:', data);
            window.dispatchEvent(new CustomEvent('rn-purchase-success', { detail: data }));
            window.dispatchEvent(new CustomEvent('rn:v2:sensor-ready', { detail: data }));
            // If a protected callback is waiting, execute it now
            if (hgInstance._pendingCallback && typeof hgInstance._pendingCallback === 'function') {
                hgInstance.hideModal();
                hgInstance._pendingCallback(data);
                hgInstance._pendingCallback = null;
            }
        }
    });

    // --- V1 Compatibility: RN_Monitor.track() ---
    hgInstance.track = async function () {
        if (window.RN_DEBUG) console.log('[RN-UNIVERSAL] V1 track signal sent.');
        await this.restoreSession();
        return true; // Fail-open: never block legitimate users
    };

    // Expose universal adapters immediately (synchronous, no latency)
    window.RN_Monitor  = hgInstance;  // V1 adapter
    window.RN_V2       = hgInstance;  // V2 adapter
    window.RealNode   = RealNode;   // V3 class
    window.RN_SensorMatrix = RN_SensorMatrix; // Available but NOT triggered yet

    // V2 guard flag — set to true immediately so existing V2 buy buttons work
    hgInstance._isPayloadReady = true;

    // currentIDH property (sentinel-logic.js compatibility)
    if (!window.currentIDH) {
        Object.defineProperty(window, 'currentIDH', { get: () => hgInstance.currentIdh });
    }

    // --- Tier Detection: fetch /sdk/config, then activate features ---
    // This is the only async part. Runs in background, never blocks page render.
    (async () => {
        try {
            const url = _hgApiKey
                ? `${_hgApiBase}/sdk/config?api_key=${encodeURIComponent(_hgApiKey)}`
                : `${_hgApiBase}/sdk/config`;

            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) throw new Error('config fetch failed');
            const cfg = await resp.json();

            const tier     = (cfg.tier     || 'SHADOW').toUpperCase();
            const features = cfg.features  || {};

            if (window.RN_DEBUG) console.log(`[RN-UNIVERSAL] Tier detected: ${tier}`);

            // --- Activate V2 SensorMatrix (SMART or ELITE) ---
            if (features.sensor_matrix) {
                RN_SensorMatrix.autoTrigger();
                if (window.RN_DEBUG) console.log('[RN-UNIVERSAL] SensorMatrix activated (V2+).');
            }

            // --- Activate V3 Biometric Modal (ELITE only) ---
            if (features.biometric_modal) {
                hgInstance._injectBiometricModal();
                // Auto-protect any element marked data-rn-protect="true"
                document.querySelectorAll('[data-rn-protect]').forEach(btn => {
                    hgInstance.protect(btn, (data) => {
                        btn.dispatchEvent(new CustomEvent('rn:verified', { bubbles: true, detail: data }));
                    });
                });
                if (window.RN_DEBUG) console.log('[RN-UNIVERSAL] Biometric modal activated (V3).');
            } else {
                // IF NOT V3 (No Biometric Modal), auto-protect using silent V1/V2 check
                document.querySelectorAll('[data-rn-protect]').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        try {
                            const res = await hgInstance.verify();
                            btn.dispatchEvent(new CustomEvent('rn:verified', { bubbles: true, detail: res }));
                        } catch (err) {
                            console.error("[RN-UNIVERSAL] Verification Error", err);
                        }
                    });
                });
                if (window.RN_DEBUG) console.log('[RN-UNIVERSAL] Silent Protection bound to DOM elements (V1/V2).');
            }

        } catch (e) {
            // Network error or server down: fail silently, keep V1 passive mode
            if (window.RN_DEBUG) console.warn('[RN-UNIVERSAL] Tier detection failed, defaulting to SHADOW.', e);
        }
    })();

    console.log('[RN-UNIVERSAL] SDK v4.0 — One integration, all tiers.');
}
