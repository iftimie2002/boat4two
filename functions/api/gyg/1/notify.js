import {
  authorizeGyGRequest,
  errorResponse,
  parseJsonBody,
  successResponse
} from "../_shared.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authFailure = authorizeGyGRequest(request, env);

  if (authFailure) {
    return authFailure;
  }

  try {
    const body = await parseJsonBody(request);

    console.log("GYG notification received", JSON.stringify(body || {}));

    return successResponse({});
  } catch (error) {
    console.error("GYG notify failed", error);

    return errorResponse(
      "INTERNAL_SYSTEM_FAILURE",
      error?.message || "Failed to process notification."
    );
  }
}

