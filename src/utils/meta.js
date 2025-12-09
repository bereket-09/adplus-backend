exports.decodeAndValidate = (base64Str) => {
  try {
    const buff = Buffer.from(base64Str, 'base64');
    // console.log("🚀 ~ buff:", JSON.parse(buff.toString('utf8')))
    const payload = JSON.parse(buff.toString('utf8'));
    // console.log("🚀 ~ payload:", payload)
    const required = ['msisdn', 'ip', 'userAgent', 'deviceInfo', 'location'];
    for (let r of required) if (!payload[r]) return { valid: false, report: `missing ${r}` };
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, report: e.message };
  }
};
