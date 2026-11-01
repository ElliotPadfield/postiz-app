import {
  AuthProvider,
  AuthProviderAbstract,
} from '@gitroom/backend/services/auth/providers.interface';
import { randomBytes } from 'crypto';
import { stateStore } from '@gitroom/nestjs-libraries/state/postgres.state';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { sign, verify } from 'jsonwebtoken';

function hexToUint8Array(hex) {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }

  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string. It must have an even length.');
  }

  const byteLength = hex.length / 2;
  const uint8Array = new Uint8Array(byteLength);

  for (let i = 0; i < byteLength; i++) {
    const byteHex = hex.substr(i * 2, 2);
    uint8Array[i] = parseInt(byteHex, 16);
  }

  return uint8Array;
}

@AuthProvider({ provider: 'WALLET' })
export class WalletProvider extends AuthProviderAbstract {
  async generateLink(params: { publicKey: string }) {
    if (!params.publicKey) {
      return;
    }

    const challenge = randomBytes(32).toString('hex');
    await stateStore.set(`wallet:${params.publicKey}`, challenge, 'EX', 60);

    return challenge;
  }

  async getToken(code: string, _redirectUri?: string) {
    const { publicKey, challenge, signature } = JSON.parse(
      Buffer.from(code, 'base64').toString()
    );

    if (!publicKey || !challenge || !signature) {
      return '';
    }

    const redisGet = await stateStore.get(`wallet:${publicKey}`);
    if (redisGet !== challenge) {
      return '';
    }

    const publicKeyUint8 = bs58.decode(publicKey);
    const messageUint8 = new TextEncoder().encode(challenge);
    const signatureUint8 = hexToUint8Array(signature);
    const isValid = nacl.sign.detached.verify(
      messageUint8,
      signatureUint8,
      publicKeyUint8
    );

    if (!isValid) {
      return '';
    }

    if ((await stateStore.consume(`wallet:${publicKey}`)) !== challenge)
      return '';
    // OAuth login resolves the user and may then hand the same token to the
    // registration screen. Consume the challenge once, then use a short-lived
    // signed identity token for those two reads, as other OAuth providers do.
    return sign(
      { publicKey, purpose: 'wallet-login' },
      process.env.JWT_SECRET!,
      {
        algorithm: 'HS256',
        expiresIn: '5m',
        issuer: 'postiz-wallet',
        audience: 'postiz-auth',
      }
    );
  }

  async getUser(providerToken: string) {
    let identity: any;
    try {
      identity = verify(providerToken, process.env.JWT_SECRET!, {
        algorithms: ['HS256'],
        issuer: 'postiz-wallet',
        audience: 'postiz-auth',
      });
    } catch {
      const token = await this.getToken(providerToken).catch(() => '');
      if (token)
        identity = verify(token, process.env.JWT_SECRET!, {
          algorithms: ['HS256'],
          issuer: 'postiz-wallet',
          audience: 'postiz-auth',
        });
    }
    if (
      !identity ||
      identity.purpose !== 'wallet-login' ||
      typeof identity.publicKey !== 'string'
    ) {
      return {
        id: '',
        email: '',
      };
    }

    const { publicKey } = identity;

    return {
      id: String(`wallet_${publicKey}`),
      email: String(`wallet_${publicKey}`),
    };
  }
}
