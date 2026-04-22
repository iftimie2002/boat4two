function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

const MYPOS_EMBEDDED_PRODUCTION_URL = "https://mypos.com/vmp/checkout";
const MYPOS_EMBEDDED_TEST_URL = "https://mypos.com/vmp/checkout-test";

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function isMyposSandboxUrl(value) {
  return /checkout-test/i.test(String(value || ""));
}

function getMyposEmbeddedCheckoutUrl(env) {
  return isMyposSandboxUrl(env.MYPOS_CHECKOUT_URL)
    ? MYPOS_EMBEDDED_TEST_URL
    : MYPOS_EMBEDDED_PRODUCTION_URL;
}

function getMessageFromStatusData(data) {
  return [
    cleanText(data?.StatusMsg, 120),
    data?.Status !== undefined && Number(data.Status) !== 0 ? `myPOS status ${data.Status}` : "",
    cleanText(data?.responseCodeDescription, 160),
    data?.responseCode ? `myPOS response code ${data.responseCode}` : ""
  ].filter(Boolean).join(". ");
}

async function callMypos(env, requestData) {
  const formData = new FormData();
  const payload = {
    ...requestData,
    OutputFormat: "json"
  };

  for (const [key, value] of Object.entries(payload)) {
    formData.append(key, value);
  }

  const response = await fetch(getMyposEmbeddedCheckoutUrl(env), {
    method: "POST",
    body: formData
  });
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("myPOS returned an invalid Apple Pay response.");
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const action = cleanText(body?.action, 40);
    const paymentSessionToken = cleanText(body?.sessionToken, 5000);

    if (!paymentSessionToken) {
      return json({ ok: false, error: "Missing Apple Pay payment session token." }, 400);
    }

    if (action === "validate") {
      const validationUrl = cleanText(body?.validationUrl, 2000);
      const merchantIdentifier = cleanText(body?.merchantIdentifier, 120);
      const domain = cleanText(body?.domain || new URL(request.url).hostname, 255);

      if (!validationUrl || !merchantIdentifier || !domain) {
        return json({ ok: false, error: "Missing Apple Pay merchant validation parameters." }, 400);
      }

      const statusData = await callMypos(env, {
        IPCMethod: "IPCApplePayDomainSession",
        Url: validationUrl,
        Domain: domain,
        MerchantIdentifier: merchantIdentifier,
        PaymentSessionToken: paymentSessionToken
      });

      if (Number(statusData?.Status) !== 0 || !statusData?.Content) {
        return json({
          ok: false,
          error: getMessageFromStatusData(statusData) || "myPOS could not validate the Apple Pay merchant session.",
          statusData
        }, 400);
      }

      try {
        return json({
          ok: true,
          merchantSession: JSON.parse(statusData.Content),
          statusData
        });
      } catch (_) {
        return json({
          ok: false,
          error: "myPOS returned an invalid Apple Pay merchant session.",
          statusData
        }, 400);
      }
    }

    if (action === "process") {
      if (!body?.applePayToken) {
        return json({ ok: false, error: "Missing Apple Pay payment token." }, 400);
      }

      const statusData = await callMypos(env, {
        IPCMethod: "IPCApplePayProcess",
        ApplePayToken: JSON.stringify(body.applePayToken),
        PaymentSessionToken: paymentSessionToken
      });

      if (Number(statusData?.Status) !== 0) {
        return json({
          ok: false,
          error: getMessageFromStatusData(statusData) || "myPOS rejected the Apple Pay payment.",
          statusData
        }, 402);
      }

      return json({
        ok: true,
        statusData
      });
    }

    return json({ ok: false, error: "Invalid Apple Pay action." }, 400);
  } catch (error) {
    return json({
      ok: false,
      error: error.message || "Unknown Apple Pay error."
    }, 500);
  }
}

export async function onRequestGet() {
  return json({
    ok: true,
    message: "Use POST to validate or process Apple Pay."
  });
}
