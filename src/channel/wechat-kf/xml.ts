const MAX_XML_BYTES = 256 * 1024;

export function assertBoundedXml(xml: string): void {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
    throw new Error('wechat-kf callback body is too large');
  }
}

export function xmlElement(xml: string, name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid XML element name');
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${name}>`,
  ).exec(xml);
  const cdata = match?.[1];
  if (cdata !== undefined) return cdata.trim();
  const text = match?.[2];
  return text === undefined ? undefined : decodeXmlText(text.trim());
}

export function requiredXmlElement(xml: string, name: string): string {
  const value = xmlElement(xml, name);
  if (value === undefined || value === '') {
    throw new Error(`wechat-kf callback is missing ${name}`);
  }
  return value;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
