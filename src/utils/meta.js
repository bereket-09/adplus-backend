exports.decodeAndValidate = (base64Str, req = {}) => {
  try {
    const buff = Buffer.from(base64Str, "base64");
    const payload = JSON.parse(buff.toString("utf8"));

    /* ---------------- Required top-level fields ---------------- */
    const requiredTopLevel = ["msisdn", "ip", "userAgent", "device", "location"];
    for (const key of requiredTopLevel) {
      if (!payload[key]) {
        return { valid: false, report: `missing ${key}` };
      }
    }

    /* ---------------- Device validation ---------------- */
    const requiredDevice = ["type", "model", "brand", "platform"];
    for (const key of requiredDevice) {
      if (!payload.device[key]) {
        return { valid: false, report: `missing device.${key}` };
      }
    }

    /* ---------------- Location validation ---------------- */
    const requiredLocation = ["lat", "lon"];
    for (const key of requiredLocation) {
      if (
        payload.location[key] === undefined ||
        payload.location[key] === null
      ) {
        return { valid: false, report: `missing location.${key}` };
      }
    }

    /* ---------------- Sanity checks ---------------- */
    if (!/^251\d{9}$/.test(payload.msisdn)) {
      return { valid: false, report: "invalid msisdn format" };
    }

    if (typeof payload.userAgent !== "string") {
      return { valid: false, report: "invalid userAgent" };
    }

    /* ================= Validation PASSED ================= */

    // Extract real client IP (proxy-aware)
    const realIp =
      req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers?.["x-real-ip"] ||
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      null;

    if (realIp) {
      payload.ip = realIp;
    }


    // console.log("🚀 ~ Meta.decodeAndValidate ~ payload:", payload);
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, report: e.message };
  }
};


// exports.decodeAndValidate = (base64Str) => {
//   try {
//     const buff = Buffer.from(base64Str, 'base64');
//     // console.log("🚀 ~ buff:", JSON.parse(buff.toString('utf8')))
//     const payload = JSON.parse(buff.toString('utf8'));
//     // console.log("🚀 ~ payload:", payload)
//     const required = ['msisdn', 'ip', 'userAgent', 'deviceInfo', 'location'];
//     for (let r of required) if (!payload[r]) return { valid: false, report: `missing ${r}` };
//     return { valid: true, payload };
//   } catch (e) {
//     return { valid: false, report: e.message };
//   }
// };
