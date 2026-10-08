/**
 * Cloudflare Pages Function: /api/pay/toyyibpay
 * Handles ToyyibPay Bill creation with customer-paid FPX fee (billChargeToCustomer: 1)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const secretKey = env.TOYYIBPAY_SECRET_KEY;
    const categoryCode = env.TOYYIBPAY_CATEGORY_CODE || "4zr2m3v5";
    const isSandbox = (env.TOYYIBPAY_ENV || "").toLowerCase() === "sandbox";

    if (!secretKey) {
      return new Response(
        JSON.stringify({
          error: "TOYYIBPAY_SECRET_KEY is not configured in Cloudflare environment variables."
        }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    if (!categoryCode) {
      return new Response(
        JSON.stringify({
          error: "TOYYIBPAY_CATEGORY_CODE is not configured. Please create a Category in your ToyyibPay dashboard and set the code in Cloudflare environment variables."
        }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const order = await request.json();

    if (!order || !order.total || !order.customer || !order.customer.email) {
      return new Response(
        JSON.stringify({ error: "Invalid order payload. Missing customer details or total." }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const reqUrl = new URL(request.url);
    const siteUrl = (env.SITE_URL || reqUrl.origin).replace(/\/$/, "");

    const toyyibHost = isSandbox ? "https://dev.toyyibpay.com" : "https://toyyibpay.com";
    const createBillUrl = `${toyyibHost}/index.php/api/createBill`;

    // Amount in sen (cents), e.g. RM 250 -> 25000
    const amountInSen = Math.round(Number(order.total) * 100);

    // Sanitize customer phone for ToyyibPay
    let cleanPhone = (order.customer.phone || "").replace(/[^0-9]/g, "");
    if (cleanPhone.startsWith("60")) {
      cleanPhone = "0" + cleanPhone.slice(2);
    }
    if (!cleanPhone) cleanPhone = "0175895116";

    // Prepare ToyyibPay API parameters
    const params = new URLSearchParams();
    params.append("userSecretKey", secretKey.trim());
    params.append("categoryCode", categoryCode.trim());
    params.append("billName", `Tour Ref: ${order.ref}`.substring(0, 30));
    params.append("billDescription", `Langkawi Tour Booking ${order.ref} - ${order.customer.name}`.substring(0, 100));
    params.append("billPriceSetting", "1"); // 1 = Fixed Amount
    params.append("billPayorInfo", "1");   // 1 = Require payor info
    params.append("billAmount", amountInSen.toString());
    params.append("billReturnUrl", `${siteUrl}/?payment=toyyibpay_return&ref=${encodeURIComponent(order.ref)}`);
    params.append("billCallbackUrl", `${siteUrl}/api/pay/toyyibpay-callback`);
    params.append("billExternalReferenceNo", order.ref);
    params.append("billTo", (order.customer.name || "Customer").substring(0, 30));
    params.append("billEmail", order.customer.email);
    params.append("billPhone", cleanPhone);
    params.append("billSplitPayment", "0");
    params.append("billSplitPaymentArgs", "");
    params.append("billPaymentChannel", "0"); // 0 = Both FPX & Credit/Debit Card
    params.append("billDisplayMerchant", "1");
    params.append("billContentEmail", `Thank you for booking with Langkawi Tour & Travel. Booking Ref: ${order.ref}. Travel Date: ${order.travelDate || 'As booked'}.`);
    
    // CUSTOMER BEARS THE FEE: 1 = Charge FPX / processing fee to customer
    params.append("billChargeToCustomer", "1");

    const toyyibRes = await fetch(createBillUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const responseText = await toyyibRes.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error("ToyyibPay Non-JSON Response:", responseText);
      return new Response(
        JSON.stringify({ error: "Invalid response from ToyyibPay API: " + responseText }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // ToyyibPay returns an array: [{ "BillCode": "xxxx" }] or [{ "status": "error", "msg": "..." }]
    let billCode = null;
    if (Array.isArray(data) && data.length > 0) {
      if (data[0].BillCode) {
        billCode = data[0].BillCode;
      } else if (data[0].msg) {
        return new Response(
          JSON.stringify({ error: `ToyyibPay Error: ${data[0].msg}` }),
          { status: 400, headers: CORS_HEADERS }
        );
      }
    } else if (data && data.BillCode) {
      billCode = data.BillCode;
    }

    if (!billCode) {
      return new Response(
        JSON.stringify({ error: "Failed to obtain ToyyibPay BillCode.", details: data }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const checkoutUrl = `${toyyibHost}/${billCode}`;

    return new Response(
      JSON.stringify({
        success: true,
        checkoutUrl: checkoutUrl,
        billCode: billCode
      }),
      { status: 200, headers: CORS_HEADERS }
    );

  } catch (err) {
    console.error("ToyyibPay Handler Exception:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
