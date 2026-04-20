import { onRequestPost as handleMyposNotify } from "./mypos-notify.js";

function redirectResponse(path) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: path,
      "Cache-Control": "no-store"
    }
  });
}

async function getCallbackEntries(request) {
  if (request.method.toUpperCase() === "POST") {
    const formData = await request.formData();
    return Array.from(formData.entries()).map(([key, value]) => [String(key), String(value)]);
  }

  const url = new URL(request.url);
  return Array.from(url.searchParams.entries()).map(([key, value]) => [String(key), String(value)]);
}

async function buildNotifyRequest(context) {
  const entries = await getCallbackEntries(context.request);
  const body = new URLSearchParams();

  for (const [key, value] of entries) {
    body.append(key, value);
  }

  return new Request(new URL("/api/mypos-notify", context.request.url).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

async function handleReturn(context) {
  const notifyRequest = await buildNotifyRequest(context);
  const notifyResponse = await handleMyposNotify({
    ...context,
    request: notifyRequest
  });

  if (!notifyResponse.ok) {
    return redirectResponse("/payment-cancel.html?reason=verification_failed");
  }

  const state = notifyResponse.headers.get("X-Boat4Two-Payment-State") || "";
  if (state === "paid") {
    return redirectResponse("/payment-success.html");
  }

  return redirectResponse("/payment-cancel.html?reason=not_confirmed");
}

export const onRequestGet = handleReturn;
export const onRequestPost = handleReturn;
