// @flow
import _ from 'lodash';
import {convertPayloadToBase64, ErrorCode} from './utils';
import {API_ERROR, HTTP_STATUS, ROLES, TIME_EXPIRATION_7D, TOKEN_BASIC, TOKEN_BEARER} from './constants';

import type {
  RemoteUser,
  Package,
  Callback,
  Config,
  Security,
  APITokenOptions,
  JWTOptions} from '@verdaccio/types';
import type {
  CookieSessionToken, IAuthWebUI, AuthMiddlewarePayload, AuthTokenHeader, BasicPayload,
} from '../../types';
import {aesDecrypt, verifyPayload} from './crypto-utils';

/**
 * Builds an anonymous user in case none is logged in.
 * @return {Object} { name: xx, groups: [], real_groups: [] }
 */
export function buildAnonymousUser(): RemoteUser {
  return {
    name: undefined,
    // groups without '$' are going to be deprecated eventually
    groups: [ROLES.$ALL, ROLES.$ANONYMOUS, ROLES.DEPRECATED_ALL, ROLES.DEPRECATED_ANONUMOUS],
    real_groups: [],
  };
}

export function allow_action(action: string) {
  return function(user: RemoteUser, pkg: Package, callback: Callback) {
    const {name, groups} = user;
    const hasPermission = pkg[action].some((group) => name === group || groups.includes(group));

    if (hasPermission) {
      return callback(null, true);
    }

    if (name) {
      callback(ErrorCode.getForbidden(`user ${name} is not allowed to ${action} package ${pkg.name}`));
    } else {
      callback(ErrorCode.getForbidden(`unregistered users are not allowed to ${action} package ${pkg.name}`));
    }
  };
}

export function getDefaultPlugins() {
  return {
    authenticate(user: string, password: string, cb: Callback) {
      cb(ErrorCode.getForbidden(API_ERROR.BAD_USERNAME_PASSWORD));
    },

    add_user(user: string, password: string, cb: Callback) {
      return cb(ErrorCode.getConflict(API_ERROR.BAD_USERNAME_PASSWORD));
    },

    allow_access: allow_action('access'),
    allow_publish: allow_action('publish'),
  };
}

export function createSessionToken(): CookieSessionToken {
  return {
    // npmjs.org sets 10h expire
    expires: new Date(Date.now() + 10 * 60 * 60 * 1000),
  };
}

const defaultWebTokenOptions: JWTOptions = {
  sign: {
    expiresIn: TIME_EXPIRATION_7D,
  },
  verify: {},
};

const defaultApiTokenConf: APITokenOptions = {
    legacy: true,
    sign: {},
};

export function getSecurity(config: Config): Security {
  const defaultSecurity: Security = {
    web: defaultWebTokenOptions,
    api: defaultApiTokenConf,
  };

  if (_.isNil(config.security) === false) {
    return _.merge(defaultSecurity, config.security);
  }

  return defaultSecurity;
}

export function getAuthenticatedMessage(user: string): string {
  return `you are authenticated as '${user}'`;
}

export function buildUserBuffer(name: string, password: string) {
  return new Buffer(`${name}:${password}`);
}

export function isAESLegacy(security: Security): boolean {
  return _.isNil(security.api.legacy) === false &&
    _.isNil(security.api.jwt) &&
    security.api.legacy === true;
}

export async function getApiToken(
  auth: IAuthWebUI,
  config: Config,
  remoteUser: RemoteUser,
  aesPassword: string): Promise<string> {
  const security: Security = getSecurity(config);

  if (isAESLegacy(security)) {
     // fallback all goes to AES encryption
     return auth.aesEncrypt(buildUserBuffer((remoteUser: any).name, aesPassword)).toString('base64');
  } else {
      // i am wiling to use here _.isNil but flow does not like it yet.
    if (typeof security.api.jwt !== 'undefined' &&
      typeof security.api.jwt.sign !== 'undefined') {
      return await auth.jwtEncrypt(remoteUser, security.api.jwt.sign);
    } else {
      return auth.aesEncrypt(buildUserBuffer((remoteUser: any).name, aesPassword)).toString('base64');
    }
  }
}

export function parseAuthTokenHeader(authorizationHeader: string): AuthTokenHeader {
  const parts = authorizationHeader.split(' ');
  const [scheme, token] = parts;

  return {scheme, token};
}

export function parseBasicPayload(credentials: string): BasicPayload {
  const index = credentials.indexOf(':');
  if (index < 0) {
    return;
  }

  const user: string = credentials.slice(0, index);
  const password: string = credentials.slice(index + 1);

  return {user, password};
}

export function parseAESCredentials(
  authorizationHeader: string, secret: string) {
  const {scheme, token} = parseAuthTokenHeader(authorizationHeader);

  // basic is deprecated and should not be enforced
  if (scheme.toUpperCase() === TOKEN_BASIC.toUpperCase()) {
    const credentials = convertPayloadToBase64(token).toString();

    return credentials;
  } else if (scheme.toUpperCase() === TOKEN_BEARER.toUpperCase()) {
    const tokenAsBuffer = convertPayloadToBase64(token);
    const credentials = aesDecrypt(tokenAsBuffer, secret).toString('utf8');

    return credentials;
  } else {
    return;
  }
}

export function verifyJWTPayload(token: string, secret: string): RemoteUser {
  try {
    const payload: RemoteUser = (verifyPayload(token, secret): RemoteUser);

    return payload;
  } catch (err) {
    // #168 this check should be removed as soon AES encrypt is removed.
    if (err.name === 'JsonWebTokenError') {
      // it might be possible the jwt configuration is enabled and
      // old tokens fails still remains in usage, thus
      // we return an anonymous user to force log in.
      return buildAnonymousUser();
    } else {
      throw ErrorCode.getCode(HTTP_STATUS.UNAUTHORIZED, err.message);
    }
  }
}

export function isAuthHeaderValid(authorization: string): boolean {
  return authorization.split(' ').length === 2;
}

export function getMiddlewareCredentials(
    security: Security,
    secret: string,
    authorizationHeader: string
  ): AuthMiddlewarePayload {
  if (isAESLegacy(security)) {
    const credentials = parseAESCredentials(authorizationHeader, secret);
    if (!credentials) {
      return;
    }

    const parsedCredentials = parseBasicPayload(credentials);
    if (!parsedCredentials) {
      return;
    }

    return parsedCredentials;
  } else {
    const parts = authorizationHeader.split(' ');
    const scheme = parts[0];
    const token = parts[1];

    if (_.isString(token) && scheme.toUpperCase() === TOKEN_BEARER.toUpperCase()) {
        return verifyJWTPayload(token, secret);
    } else {
      return;
    }
  }
}
