import semVer from 'semver';
import kongState from './kongState';
import { parseUpstreams } from './parsers/upstreams';
import { parseCertificates } from './parsers/certificates';
import getCurrentStateSelector from './stateSelector';

export default async (adminApi, config) => {
    return Promise.all([kongState(adminApi), adminApi.fetchPluginSchemas(), adminApi.fetchKongVersion()])
        .then(([state, schemas, version]) => {
            return getCurrentStateSelector({
                _info: { version },
                apis: parseApis(state.apis, version),
                services: parseServices(state.services, version, config),
                consumers: parseConsumers(state.consumers),
                plugins: parseGlobalPlugins(state.plugins),
                upstreams: semVer.gte(version, '0.10.0') ? parseUpstreams(state.upstreams) : undefined,
                certificates: semVer.gte(version, '0.10.0') ? parseCertificates(state.certificates) : undefined,
            });
        })
};

export const parseConsumer = ({ username, custom_id, credentials, acls, ..._info }) => {
    return {
        username,
        custom_id,
        _info,
    };
};

export const parseAcl = ({group, ..._info}) => ({group, _info});

function parseConsumers(consumers) {
    return consumers.map(({username, custom_id, credentials, acls, ..._info}) => {
        return {
            ...parseConsumer({ username, custom_id, ..._info}),
            acls: Array.isArray(acls) ? acls.map(parseAcl) : [],
            credentials: zip(Object.keys(credentials), Object.values(credentials))
                .map(parseCredential)
                .reduce((acc, x) => acc.concat(x), [])
        };
    });
}

function zip(a, b) {
    return a.map((n, index) => [n, b[index]]);
}

function parseCredential([credentialName, credentials]) {
    if (!Array.isArray(credentials)) {
      return [];
    }

    return credentials.map(({consumer_id, id, created_at, ...attributes}) => {
        return {
            name: credentialName,
            attributes,
            _info: {id, consumer_id, created_at}
        };
    });
}

function parseApis(apis, kongVersion) {
    if (semVer.gte(kongVersion, '0.10.0')) {
        return parseApisV10(apis);
    }

    return parseApisBeforeV10(apis);
}

const parseApiPreV10 = ({
    name,
    request_host, request_path, strip_request_path, preserve_host, upstream_url,
    id, created_at}) => {
    return {
        name,
        plugins: [],
        attributes: {
            request_host,
            request_path,
            strip_request_path,
            preserve_host,
            upstream_url,
        },
        _info: {
            id,
            created_at
        }
    };
};

export const parseApiPostV10 = ({
    name, plugins,
    hosts, uris, methods,
    strip_uri, preserve_host, upstream_url, id, created_at,
    https_only, http_if_terminated,
    retries, upstream_connect_timeout, upstream_read_timeout, upstream_send_timeout}) => {
    return {
        name,
        attributes: {
            hosts,
            uris,
            methods,
            strip_uri,
            preserve_host,
            upstream_url,
            retries,
            upstream_connect_timeout,
            upstream_read_timeout,
            upstream_send_timeout,
            https_only,
            http_if_terminated
        },
        _info: {
            id,
            created_at
        }
    };
};

const withParseApiPlugins = (parseApi) => api => {
    const { name, ...rest} = parseApi(api);

    return { name, plugins: parseApiPlugins(api.plugins), ...rest };
};

function parseApisBeforeV10(apis) {
    return apis.map(withParseApiPlugins(parseApiPreV10));
}

function parseApisV10(apis) {
    return apis.map(withParseApiPlugins(parseApiPostV10));
}

export const parsePlugin = ({
    name,
    config,
    id, api_id, consumer_id, enabled, created_at
}) => {
    return {
        name,
        attributes: {
            enabled,
            consumer_id,
            config: stripConfig(config)
        },
        _info: {
            id,
            //api_id,
            consumer_id,
            created_at
        }
    };
};

function parseApiPlugins(plugins) {
    if (!Array.isArray(plugins)) {
      return [];
    }

    return plugins.map(parsePlugin);
}

export function parseRoute({ id, created_at, updated_at, service, ...rest }, serviceName = '', config = {}) {
    let name = null;
    if (serviceName !== '' && config.services) {
        const route = (config.services.find((s) => s.name === serviceName).routes || [])
              .find((r) => r.id === id);
        if (route) {
            name = route.name;
        }
    }
    return { name: (name || id), id, attributes: {...rest}, _info: { id, updated_at, created_at } };
}

function parseRoutes(routes, serviceName= '', config = {}) {
    return routes.map(({ plugins, ...route }) => {
        const { id, ...rest } = parseRoute(route, serviceName, config);
        return { id, plugins: parseApiPlugins(plugins), ...rest };
    });
}

export function parseService({
    name, plugins, host, connect_timeout, read_timeout,
    port, path, write_timeout, id, created_at, updated_at,
    protocol, retries }) {
    return {
        name,
        attributes: {
            host,
            port,
            protocol,
            path,
            retries,
            connect_timeout,
            read_timeout,
            write_timeout,
        },
        _info: {
            id,
            created_at,
            updated_at,
        }
    };
}

function parseServices(services, version, config = {}) {
    if (semVer.gte(version, '0.13.0')) {
        return services.map(({ plugins, routes, ...service }) => {
            const { name, ...rest } = parseService(service);
            return { name, plugins: parseApiPlugins(plugins), routes: parseRoutes(routes, name, config), ...rest };
        });
    }
    return [];
}

export const parseGlobalPlugin = ({
    name,
    enabled,
    config,
    id, api_id, consumer_id, created_at
}) => {
    return {
        name,
        attributes: {
            enabled,
            consumer_id,
            config: stripConfig(config)
        },
        _info: {
            id,
            api_id,
            consumer_id,
            created_at
        }
    };
};

function parseGlobalPlugins(plugins) {
    if (!Array.isArray(plugins)) {
      return [];
    }

    return plugins
        .map(parseGlobalPlugin)
        .filter(x => x.name);
}

function stripConfig(config) {
    const mutableConfig = {...config};

    // remove some cache values
    delete mutableConfig['_key_der_cache'];
    delete mutableConfig['_cert_der_cache'];

    return mutableConfig;
}
