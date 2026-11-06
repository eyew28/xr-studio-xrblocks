import { createPrivateKey, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TlsOptions {
  key: string;
  cert: string;
}

/**
 * Loads the HTTPS key and certificate from the `certs` folder. Files are told
 * apart by their contents, since a `.pem` can hold either one. Returns undefined
 * when the folder has no files, so the server falls back to plain HTTP.
 */
export function loadTlsOptions(): TlsOptions | undefined {
  const certsDir = path.resolve(process.cwd(), 'certs');
  if (!fs.existsSync(certsDir)) return undefined;

  const fileNames = fs
    .readdirSync(certsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  if (fileNames.length === 0) return undefined;

  const keys: string[] = [];
  const certs: string[] = [];
  for (const fileName of fileNames) {
    const contents = fs.readFileSync(path.join(certsDir, fileName), 'utf8');
    if (contents.includes('ENCRYPTED PRIVATE KEY') || contents.includes('Proc-Type: 4,ENCRYPTED')) {
      throw new Error(`${fileName} in ${certsDir} is password-protected. Use an unencrypted private key.`);
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(contents)) keys.push(contents);
    if (contents.includes('-----BEGIN CERTIFICATE-----')) certs.push(contents);
  }

  if (keys.length === 0 || certs.length === 0) {
    throw new Error(
      `${certsDir} needs a private key and a certificate in PEM text format, but no ` +
        `${keys.length > 0 ? 'certificate' : certs.length > 0 ? 'private key' : 'key or certificate'} ` +
        `was found in: ${fileNames.join(', ')}`
    );
  }

  // Pick the pair that belongs together, as the folder may also hold other
  // certificates, such as the CA certificate that signed the server's one.
  for (const key of keys) {
    const privateKey = createPrivateKey(key);
    const cert = certs.find((candidate) => new X509Certificate(candidate).checkPrivateKey(privateKey));
    if (cert) return { key, cert };
  }
  throw new Error(
    `No certificate in ${certsDir} matches the private key. Use the certificate that was generated ` +
      `with that key (a CA certificate such as rootCA.crt will not work). Found: ${fileNames.join(', ')}`
  );
}
