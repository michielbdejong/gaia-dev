/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["ExtensionStorageSync"];

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;


const STORAGE_SYNC_ENABLED = 'extension.storage.sync.enabled';
const MIN_SYNC_INTERVAL = 1000;
const AREA_NAME = 'sync';


Cu.import("resource://services-common/moz-kinto-client.js");

Cu.import("resource://gre/modules/Preferences.jsm");

Cu.import("resource://gre/modules/Task.jsm");

Cu.import("resource://gre/modules/FxAccounts.jsm");

// TODO:
// * mock sync server
// * encryption function
// * Kinto server linked to FxA

/* globals ExtensionStorageSync */

var collPromise = {};
var lastSync = {};
var syncTimer = {};

function openColl(extensionId) {
  dump('Loading Kinto\n' + extensionId);
  const Kinto = loadKinto();
  var coll;
  if (!Kinto) {
    return Promise.reject(new Error('Not supported'));
  }
  function encoderFunc(kB) {
    return function(record) {
      dump('fake encoding ' + kB + ' ' + JSON.stringify(record));
      return Promise.resolve(record);
    };
  }

  function decoderFunc(kB) {
    return function(record) {
      dump('fake decoding ' + kB + ' ' + JSON.stringify(record));
      return Promise.resolve(record);
    };
  }
  return Task.spawn(function* () {
    const db = new Kinto({
      adapter: Kinto.adapters.FirefoxAdapter,
      remoteTransformers: [
        {
          encode: encoderFunc(('not signed in')),
          decode: decoderFunc(('not signed in'))
        }
      ]
    });
    coll = db.collection(extensionId);
    yield coll.db.open('storage-sync.sqlite');
  }).then(() => {
    return coll;
  }).catch(err => {
    dump('error opening SqlLite '+err.message);
    throw err;
  });
}

var md5 = function(str) {
  // In a deterministic way, make sure string is long enough:
  str = '-----------------------------' + str;
  // Adapted from toolkit/components/url-classifier/content/moz/cryptohasher.js:
  var hasher_ = Cc["@mozilla.org/security/hash;1"]
                   .createInstance(Ci.nsICryptoHash);
  hasher_.init(Ci.nsICryptoHash.MD5);
  var stream = Cc['@mozilla.org/io/string-input-stream;1']
                 .createInstance(Ci.nsIStringInputStream);
  stream.setData(str, str.length);
  if (stream.available()) {
    hasher_.updateFromStream(stream, stream.available());
  }

  var digest = hasher_.finish(false /* not b64 encoded */);

  var hexchars = '0123456789ABCDEF';
  var hexrep = new Array(str.length * 2);

  for (var i = 0; i < str.length; ++i) {
    hexrep[i * 2] = hexchars.charAt((digest.charCodeAt(i) >> 4) & 15);
    hexrep[i * 2 + 1] = hexchars.charAt(digest.charCodeAt(i) & 15);
  }
  return hexrep.join('').toLowerCase();
}

function keyToId(key) {
  let md5Str = md5(key);
  const parts = [];
  [8,4,4,4,12].map(numChars => {
    parts.push(md5Str.substr(0, numChars));
    md5Str = md5Str.substr(numChars);
  });
  dump('keyToId ' + key + ' -> ' + parts.join('-') + '\n\n\n');
  return parts.join("-");
}

this.ExtensionStorageSync = {
  listeners: new Map(),

  sync(extensionId) {
    return fxAccounts.getSignedInUser().then(user => {
      dump("LOGGED IN TO FXA "+ JSON.stringify(user));
      if (!user) {
        return Promise.reject('Not signed in to FxA');
      }
      if (!user.oauthTokens) {
        return Promise.reject('FxA user has no OAuth tokens');
      }
      if (!user.oauthTokens.kinto) {
        return Promise.reject('FxA user does not have OAuth token for Kinto');
      }
      return this.getCollection(extensionId).then(coll => {
        return coll.sync({
          remote: 'https://kinto.dev.mozaws.net/v1/',
          headers: {
            Authorization: 'Bearer ' + user.oauthTokens.kinto.token
          }
        });
      });
    }).then(syncResults => {
      let changes = {};
      syncResults.created.map(record => {
        changes[record.key] = {
          oldValue: undefined,
          newValue: record.data
        };
      });
      syncResults.updated.map(record => {
        // TODO: work out what the previous version was when a record was updated
        changes[record.key] = {
          oldValue: "unknown",
          newValue: record.data
        };
      });
      syncResults.deleted.map(record => {
        changes[record.key] = {
          oldValue: record.data,
          newValue: undefined
        };
      });
      syncResults.conflicts.map(conflict => {
        changes[conflict.remote.key] = {
          oldValue: conflict.local.data,
          newValue: conflict.remote.data
        };
        this.items.resolve(conflict, conflict.remote);
      });
      this.notifyListeners(extensionId, changes);
      dump("syncResults: " + JSON.stringify(syncResults));
    }).catch(err => {
      dump("sync error: " + err.message);
      throw err;
    });
  },

  maybeSync(extensionId) {
    if (syncTimer[extensionId]) {
      return;
    }
    let delay = 0;
    if (lastSync[extensionId]) {
      delay = lastSync[extensionId] + MIN_SYNC_INTERVAL - new Date().getTime();
    }
    if (delay < 0) {
      delay = 0;
    }
    syncTimer[extensionId] = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    syncTimer[extensionId].initWithCallback({
      notify: function() {
        dump("\n\nSYNCING!!!\n\n");
        lastSync[extensionId] = new Date().getTime();
        delete syncTimer[extensionId];
        this.sync(extensionId);
      }.bind(this)
    }, delay, Ci.nsITimer.TYPE_ONE_SHOT);
  },

  getCollection(extensionId) {
    if (Preferences.get(STORAGE_SYNC_ENABLED, false) !== true) {
      return Promise.reject(`Please set ${STORAGE_SYNC_ENABLED} to true in about:config`);
    }
    if (!collPromise[extensionId]) {
      dump('opening coll!');
      collPromise[extensionId] = openColl(extensionId);
    }
    this.maybeSync(extensionId);
    dump('returning coll');
    return collPromise[extensionId];
  },

  set(extensionId, items) {
    dump('setting' + JSON.stringify(items));
    return this.getCollection(extensionId).then(coll => {
      dump('enabled!');
      let changes = {};

      function createOrUpdateItem(record) {
        function createItem() {
          changes[record.key] = {
            oldValue: undefined,
            newValue: record.data
          };
          return coll.create(record, {useRecordId: true});
        }

        function updateItem(old_record) {
          if (old_record._status === "deleted") {
            changes[record.key] = {
              oldValue: undefined,
              newValue: record.data
            };
            return coll.delete(old_record.id, { virtual: false }).then(() => {
              return coll.create(record, {useRecordId: true});
            });
          }
          changes[record.key] = {
            oldValue: old_record.data,
            newValue: record.data
          };
          return coll.update(record);
        }

        return coll.get(record.id, { includeDeleted: true })
          .then(function(old_record) {
            dump('old_record!');
            return updateItem(old_record.data);
          }, function(reason) {
            dump('no old_record!');
            if (reason.message.indexOf(" not found.") !== -1) {
              return createItem();
            }
            dump('\n\nhave reason ' + reason + JSON.stringify(record));
            throw reason;
          });
      }

      const promises = [];
      dump('setting items' + JSON.stringify(items));
      for(let itemId in items) {
        promises.push(createOrUpdateItem({
          id: keyToId(itemId),
          key: itemId,
          data: items[itemId]
        }));
      }
      return Promise.all(promises).then(results => {
        dump('notifying after set');
        this.notifyListeners(extensionId, changes);
      });
    }).then(res => {
      dump('set success' + JSON.stringify(res));
      return res;
    }, err => {
      dump('set fail' + JSON.stringify(err));
      throw err;
    });
  },

  remove(extensionId, keys) {
    return this.getCollection(extensionId).then(coll => {
      keys = [].concat(keys);
      let changes = {};

      function removeItem(key) {
        dump('removing key '+key);
        return coll.get(keyToId(key)).then(record => {
          if (!record) {
            return;
          }
          changes[key] = {
            oldValue: record.data.data,
            newValue: undefined
          };
          dump('added removal change', JSON.stringify(record));
          return coll.delete(keyToId(key));
        }).catch(err => {
          if (err.message.indexOf(" not found.") !== -1) {
            return;
          }
          throw err;
        });
      }
      return Promise.all(keys.map(removeItem))
        .then(() => {
          dump('notifying after remove');
          this.notifyListeners(extensionId, changes);
        });

    });
  },

  clear(extensionId) {
    return this.getCollection(extensionId).then(coll => {
      let changes = [];
      return coll.list().then(records => {
        dump('\n\n\n\nclear removes records '+JSON.stringify(records) + '\n\n\n\n');
        const promises = records.data.map(record => {
          dump('\n\n\n\nclear removes '+JSON.stringify(record) + '\n\n\n\n');
          changes[record.key] = {
            oldValue: record.data,
            newValue: undefined
          };
          return coll.delete(record.id);
        });
        return Promise.all(promises);
      }).then(result => {
        dump('notifying after clear '+ JSON.stringify(result) +
            ' changes:' + JSON.stringify(changes));
        this.notifyListeners(extensionId, changes);
      });
    });
  },

  get(extensionId, spec) {
    return this.getCollection(extensionId).then(coll => {
      let keys, records;
      if (spec === null) {
        records = {};
        return coll.list().then(function(res) {
          res.data.map(record => {
            records[record.key] = record.data;
          });
          return records;
        });
      }
      if (typeof spec === 'string') {
        keys = [spec];
        records = {};
      } else if (Array.isArray(spec)) {
        keys = spec;
        records = {};
      } else {
        keys = Object.keys(spec);
        records = spec;
      }

      return Promise.all(keys.map(key => {
        dump('getting key '+key);
        return coll.get(keyToId(key)).then(function (res) {
          if (res) {
            records[res.data.key] = res.data.data;
            return res.data;
          } else {
            return Promise.reject("boom");
          }
        }, function () {
          // XXX we just swallow the error and not set any key
        });
      })).then(() => {
        return records;
      });
    });
  },

  addOnChangedListener(extensionId, listener) {
    let listeners = this.listeners.get(extensionId) || new Set();
    listeners.add(listener);
    this.listeners.set(extensionId, listeners);
    dump("Added a listener!" + extensionId);
  },

  removeOnChangedListener(extensionId, listener) {
    let listeners = this.listeners.get(extensionId);
    listeners.delete(listener);
    dump("Removed a listener!" + extensionId);
  },

  notifyListeners(extensionId, changes) {
    dump("Notifying listeners!" + extensionId + JSON.stringify(changes));
    let listeners = this.listeners.get(extensionId);
    if (listeners) {
      for (let listener of listeners) {
        listener(changes);
      }
    }
  },
};
