# RealNode Client SDK 

The official browser and React client for the **RealNode Hardware Attestation Protocol**. Built specifically for High-Demand Ticketing, Flash Sales, and environments where automated traffic outpaces standard software analysis.

By enforcing hardware-level biometric authentication (FIDO2/WebAuthn/Passkeys), RealNode mathematically guarantees proof of human presence, eliminating bots, scalpers, and credential stuffing.

---

## The RealNode Ecosystem

RealNode is distributed across multiple platforms to ensure seamless integration into any technology stack. 

### 1. NPM SDK (React, Next.js, Node.js)
For modern web applications, we provide a fully-typed, SSR-safe React SDK.
- **Package:** [@emkaylabs/realnode-sdk](https://www.npmjs.com/package/@emkaylabs/realnode-sdk)
- **Features:** React Hooks, drop-in Checkout Components, and Account Device Management UIs.
- **Installation:** `npm install @emkaylabs/realnode-sdk`

### 2. WordPress / WooCommerce Plugin
For e-commerce merchants on WordPress, we provide a no-code integration plugin that secures WooCommerce checkouts.
- **Plugin Directory:** [RealNode Anti-Scalper on WordPress.org](https://wordpress.org/plugins/realnode-anti-scalper/)
- **Features:** One-click activation, silent Insight mode, aggressive Sentinel blocking.

### 3. Vanilla JS (CDN)
For legacy architectures, the core client can be loaded directly without build steps.
- **Source Code:** [`rn-client.js`](./rn-client.js)

---

##  Interactive Sandbox

Want to see how RealNode stops bots without relying on CAPTCHAs? Test the full biometric protocol in your browser.

 **[Test the RealNode Sandbox](https://realnode.emkaylabs.tech/sandbox)** *(Free account required)*

---

##  Features (Vanilla JS Client)

- **Zero Dependencies**: A single, lightweight (`< 20kb`), asynchronous script.
- **Hardware-Backed**: Interfaces natively with device security modules (TouchID, FaceID, Windows Hello).
- **Silent Operation**: Operates asynchronously without blocking the main thread or impacting Lighthouse scores.
- **Privacy by Design**: Collects zero PII. All data is reduced to anonymous hardware hashes (IDH) before transmission.

##  Installation (Vanilla JS)

You can load the SDK directly via CDN in your HTML entry point. No NPM installation is required, allowing the script to self-update securely.

```html
<!-- 1. Define your Public Configuration -->
<script>
  window.RN_CONFIG = {
    apiKey: "pk_live_YOUR_PUBLIC_KEY" // Safe to expose in the browser
  };
</script>

<!-- 2. Load the asynchronous SDK -->
<script type="module" src="https://api.emkaylabs.tech/rn-client.js"></script>
```

##  Quick Start (Vanilla / Basic DOM)

The SDK works seamlessly within modern SPAs. Since it binds to the `window` object, you only need to call the verification function prior to high-risk actions (e.g., Checkout, Registration).

```javascript
import { useEffect, useState } from 'react';

export default function CheckoutButton() {
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    // 1. Listen for the SDK's verification event
    const handleVerification = async (e) => {
      setIsProcessing(true);
      const result = e.detail;

      try {
        if (result.status === 'authorized') {
          // Send result to YOUR backend for /consume validation
          await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idh: result.idh, device_hash: result.device_hash })
          });
          
          // Proceed with your payment logic
        } else {
          alert("Security validation failed (Bot detected).");
        }
      } catch (error) {
        console.error("RealNode checkout error:", error);
      } finally {
        setIsProcessing(false);
      }
    };

    const btn = document.getElementById('rn-btn-checkout');
    if (btn) btn.addEventListener('rn:verified', handleVerification);

    return () => {
      if (btn) btn.removeEventListener('rn:verified', handleVerification);
    };
  }, []);

  return (
    // 2. Add data-rn-protect to intercept clicks automatically
    <button id="rn-btn-checkout" data-rn-protect disabled={isProcessing}>
      {isProcessing ? "Verifying..." : "Complete Purchase"}
    </button>
  );
}
```
*(Note: For strict React/Next.js projects, use the NPM package `@emkaylabs/realnode-sdk` instead of this Vanilla DOM approach).*

---

##  Architecture Philosophy: Why Open-Core?

In cybersecurity, trust cannot be demanded; it must be proven. 
By making our client SDK public, we allow security engineers, CTOs, and integration teams to audit exactly what data is collected from the browser and how the cryptographic challenges are handled. 

Our backend infrastructure—which processes these cryptographic signatures and handles the global threat-intelligence network—remains proprietary to prevent adversarial reverse-engineering.

---

## Resources & Documentation

- **Official Website:** [realnode.emkaylabs.tech](https://realnode.emkaylabs.tech)
- **Technical Blog & Integration Guide:** [realnode.emkaylabs.tech/blog](https://realnode.emkaylabs.tech/blog)
- **B2B Inquiries & Enterprise:** [realnode@emkaylabs.tech](mailto:realnode@emkaylabs.tech)
- **Security Support:** [security@emkaylabs.tech](mailto:security@emkaylabs.tech)

---

##  License

RealNode core infrastructure and proprietary logic are maintained by EMKAY LABS.
This Client SDK is open-sourced and distributed under the **MIT License**.
