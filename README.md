# RealNode Client SDK

The official, zero-dependency browser client for the **RealNode Hardware Attestation Protocol**. 
Built specifically for High-Demand Ticketing, Flash Sales, and environments where automated traffic outpaces standard software analysis.

## Overview

Generalist software security fails when stocks vanish in seconds. Behavioral models require time to learn, which is time you do not have during a flash sale. 

RealNode takes a deterministic approach. By delegating the initial threat vector validation to the client-side hardware enclave (using FIDO2/WebAuthn and Hardware Device Fingerprinting), RealNode stops automated scalpers instantly, silently, and with **zero personal data retention**.

This repository contains the public client SDK (`rn-client.js`). Our backend architecture (passive behavioral engine, cryptographic validators, and atomic SQL quotas) remains strictly closed-source. This Open-Core approach guarantees absolute transparency regarding what executes on your end-users' devices while protecting our core detection algorithms.

## Features

- **Zero Dependencies**: A single, lightweight (`< 20kb`), asynchronous script.
- **Hardware-Backed**: Interfaces natively with device security modules (TouchID, FaceID, Windows Hello).
- **Silent Operation**: Operates asynchronously without blocking the main thread or impacting Lighthouse scores.
- **Privacy by Design**: Collects zero PII. All data is reduced to anonymous hardware hashes (IDH) before transmission.

## Installation

You can load the SDK directly via CDN in your HTML entry point. No NPM installation is required, allowing the script to self-update securely.

```html
<!-- 1. Define your Public Configuration -->
<script>
  window.RN_CONFIG = {
    apiKey: "pk_live_YOUR_PUBLIC_KEY" // Safe to expose in the browser
  };
</script>

<!-- 2. Load the asynchronous SDK -->
<script type="module" src="https://app.realnode.emkaylabs.tech/rn-client.js"></script>
```

## Quick Start (React / Next.js)

The SDK works seamlessly within modern SPAs. Since it binds to the `window` object, you only need to call the verification function prior to high-risk actions (e.g., Checkout, Registration).

```javascript
import { useState } from 'react';

export default function CheckoutButton() {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleCheckout = async () => {
    setIsProcessing(true);

    try {
      // 1. Request Hardware Attestation
      // If the user is flagged as trusted, this resolves silently in <10ms.
      // If the user is doubtful (RN Sentinel) or verification is mandated (RN Vault),
      // a native FIDO2 prompt is triggered automatically.
      const result = await window.RN_V2.verify();

      if (result.status === 'allowed') {
        // Proceed with your payment logic
        await processPayment();
        
        // Consume the quota post-transaction
        await window.RN_V2.consume(1);
      } else {
        alert("Security validation failed.");
      }
    } catch (error) {
      console.error("RealNode validation error:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <button onClick={handleCheckout} disabled={isProcessing}>
      {isProcessing ? "Verifying..." : "Complete Purchase"}
    </button>
  );
}
```

## Architecture Philosophy: Why Open-Core?

In cybersecurity, trust cannot be demanded; it must be proven. 
By making our client SDK public, we allow security engineers, CTOs, and integration teams to audit exactly what data is collected from the browser and how the cryptographic challenges are handled. 

Our backend infrastructure—which processes these cryptographic signatures and handles the global threat-intelligence network—remains proprietary to prevent adversarial reverse-engineering.

## Support & Enterprise

For integration assistance, custom SLA requirements, or Enterprise volumes, please contact our engineering team at `realnode@emkaylabs.tech`.

---
*© 2026 RealNode by EmkayLabs. All rights reserved.*
