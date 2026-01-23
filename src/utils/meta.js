exports.decodeAndValidate = (base64Str) => {
  try {
    const buff = Buffer.from(base64Str, "base64");
    const payload = JSON.parse(buff.toString("utf8"));

    // Required top-level fields
    const requiredTopLevel = ["msisdn", "ip", "userAgent", "device", "location"];
    for (const key of requiredTopLevel) {
      if (!payload[key]) {
        return { valid: false, report: `missing ${key}` };
      }
    }

    // Device validation
    const requiredDevice = ["type", "model", "brand", "platform"];
    for (const key of requiredDevice) {
      if (!payload.device[key]) {
        return { valid: false, report: `missing device.${key}` };
      }
    }

    // Location validation
    const requiredLocation = ["lat", "lon"];
    for (const key of requiredLocation) {
      if (payload.location[key] === undefined || payload.location[key] === null) {
        return { valid: false, report: `missing location.${key}` };
      }
    }

    // Optional but recommended sanity checks
    if (!/^251\d{9}$/.test(payload.msisdn)) {
      return { valid: false, report: "invalid msisdn format" };
    }

    if (typeof payload.userAgent !== "string") {
      return { valid: false, report: "invalid userAgent" };
    }

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
