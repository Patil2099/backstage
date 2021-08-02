/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ldap, { Client, SearchEntry, SearchOptions } from 'ldapjs';
import { Logger } from 'winston';
import { ansiColors } from '../util';
import { BindConfig } from './config';
import { errorString } from './util';
import {
  ActiveDirectoryVendor,
  DefaultLdapVendor,
  LdapVendor,
} from './vendors';

/**
 * Basic wrapper for the ldapjs library.
 *
 * Helps out with promisifying calls, paging, binding etc.
 */
export class LdapClient {
  private vendor: Promise<LdapVendor> | undefined;

  static async create(
    logger: Logger,
    target: string,
    bind?: BindConfig,
  ): Promise<LdapClient> {
    const client = ldap.createClient({ url: target });

    // We want to have a catch-all error handler at the top, since the default
    // behavior of the client is to blow up the entire process when it fails,
    // unless an error handler is set.
    client.on('error', (err: ldap.Error) => {
      logger.warn(`LDAP client threw an error, ${errorString(err)}`);
    });

    if (!bind) {
      return new LdapClient(client);
    }

    return new Promise<LdapClient>((resolve, reject) => {
      const { dn, secret } = bind;
      client.bind(dn, secret, err => {
        if (err) {
          reject(`LDAP bind failed for ${dn}, ${errorString(err)}`);
        } else {
          resolve(new LdapClient(client));
        }
      });
    });
  }

  constructor(private readonly client: Client) {}

  /**
   * Performs an LDAP search operation.
   *
   * @param dn The fully qualified base DN to search within
   * @param options The search options
   */
  async search(
    dn: string,
    options: SearchOptions & { type: 'users' | 'groups' },
    logger: Logger,
  ): Promise<SearchEntry[]> {
    try {
      return await new Promise<SearchEntry[]>((resolve, reject) => {
        const output: SearchEntry[] = [];
        let newUsers = 0;
        logger.info(
          `Searching LDAP directory ${
            dn ? `at dn ${ansiColors.yellow}${dn}${ansiColors.reset} ` : ''
          }with filter ${ansiColors.yellow}${options.filter}${
            ansiColors.reset
          },`,
        );
        const loggingTimeout = setInterval(() => {
          const newUsersInTheLast5Seconds = output.length - newUsers;
          logger.info(
            `found ${output.length} ${options.type} so far... (${
              newUsersInTheLast5Seconds ? ansiColors.green : ansiColors.red
            }+${newUsersInTheLast5Seconds}${
              ansiColors.reset
            } in the last 5 seconds)`,
          );
          if (newUsersInTheLast5Seconds === 0) {
            logger.warn(
              'Your LDAP server appears to be throttling our requests, or may be unresponsive. Please adjust your network conditions or talk to the responsible team.',
            );
          }
          newUsers = output.length;
        }, 5000);

        this.client.search(dn, { paged: true, ...options }, (err, res) => {
          if (err) {
            reject(new Error(errorString(err)));
            return;
          }

          res.on('searchReference', () => {
            reject(new Error('Unable to handle referral'));
          });

          res.on('searchEntry', entry => {
            output.push(entry);
          });

          res.on('error', e => {
            clearInterval(loggingTimeout);
            reject(new Error(errorString(e)));
          });

          res.on('end', r => {
            clearInterval(loggingTimeout);
            if (!r) {
              reject(new Error('Null response'));
            } else if (r.status !== 0) {
              reject(new Error(`Got status ${r.status}: ${r.errorMessage}`));
            } else {
              resolve(output);
            }
          });
        });
      });
    } catch (e) {
      throw new Error(
        `LDAP search at DN "${ansiColors.yellow}${dn}${ansiColors.reset}" failed, ${e.message}`,
      );
    }
  }

  /**
   * Get the Server Vendor.
   * Currently only detects Microsoft Active Directory Servers.
   *
   * @see https://ldapwiki.com/wiki/Determine%20LDAP%20Server%20Vendor
   */
  async getVendor(logger: Logger): Promise<LdapVendor> {
    if (this.vendor) {
      return this.vendor;
    }
    this.vendor = this.getRootDSE(logger)
      .then(root => {
        if (root && root.raw?.forestFunctionality) {
          return ActiveDirectoryVendor;
        }
        return DefaultLdapVendor;
      })
      .catch(err => {
        this.vendor = undefined;
        throw err;
      });
    return this.vendor;
  }

  /**
   * Get the Root DSE.
   *
   * @see https://ldapwiki.com/wiki/RootDSE
   */
  async getRootDSE(logger: Logger): Promise<SearchEntry | undefined> {
    const result = await this.search(
      '',
      {
        scope: 'base',
        filter: '(objectclass=*)',
        type: 'groups',
        paged: false,
      } as SearchOptions & { type: 'users' | 'groups' },
      logger,
    );
    if (result && result.length === 1) {
      return result[0];
    }
    return undefined;
  }
}
