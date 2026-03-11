'use strict';

/**
 * Proto-compatible binary serialization for sidecar RPC calls.
 *
 * Builds a minimal protobuf registry containing only the message types
 * needed for StartCascade and SendUserCascadeMessage. The descriptors are
 * hand-crafted from the field definitions decoded from the AG extension's
 * proto schemas, so no .proto files or codegen are required.
 *
 * @module sidecar/proto
 */

const { create, toBinary, fromBinary, createFileRegistry } = require('@bufbuild/protobuf');
const {
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  DescriptorProtoSchema,
  EnumDescriptorProtoSchema,
  EnumValueDescriptorProtoSchema,
} = require('@bufbuild/protobuf/wkt');

// ─────────────────────────────────────────────
// Descriptor Helpers
// ─────────────────────────────────────────────

function makeEnum(name, values) {
  return create(EnumDescriptorProtoSchema, {
    name,
    value: Object.entries(values).map(([k, v]) => create(EnumValueDescriptorProtoSchema, { name: k, number: v })),
  });
}

function makeField(name, number, type, typeName, label) {
  const f = { name, number, type };
  if (typeName) f.typeName = typeName;
  if (label) f.label = label; // 3 = LABEL_REPEATED
  return f;
}

function makeMessage(name, fields, nested) {
  const m = { name, field: fields };
  if (nested) m.nestedType = nested;
  return create(DescriptorProtoSchema, m);
}

// ─────────────────────────────────────────────
// Proto File Descriptors (minimal subset)
// ─────────────────────────────────────────────

const commonProto = create(FileDescriptorProtoSchema, {
  name: 'exa/codeium_common_pb/codeium_common.proto',
  package: 'exa.codeium_common_pb',
  messageType: [
    makeMessage('Metadata', [
      makeField('ide_name', 1, 9),
      makeField('ide_version', 7, 9),
      makeField('extension_name', 12, 9),
      makeField('extension_version', 2, 9),
      makeField('extension_path', 17, 9),
      makeField('locale', 4, 9),
      makeField('os', 5, 9),
      makeField('session_id', 10, 9),
      makeField('api_key', 3, 9),
      makeField('disable_telemetry', 6, 8),
    ]),
    makeMessage('TextOrScopeItem', [makeField('text', 1, 9)]),
    makeMessage('ModelOrAlias', [makeField('model', 1, 14, '.exa.codeium_common_pb.Model')]),
    makeMessage('ExperimentConfig', []),
    makeMessage('ImageData', [makeField('base64_data', 1, 9), makeField('mime_type', 2, 9)]),
  ],
  enumType: [
    makeEnum('Model', {
      MODEL_UNSPECIFIED: 0,
      MODEL_PLACEHOLDER_M18: 1018,
      MODEL_PLACEHOLDER_M26: 1026,
      MODEL_PLACEHOLDER_M35: 1035,
      MODEL_PLACEHOLDER_M36: 1036,
      MODEL_PLACEHOLDER_M37: 1037,
    }),
    makeEnum('ConversationalPlannerMode', {
      CONVERSATIONAL_PLANNER_MODE_UNSPECIFIED: 0,
      CONVERSATIONAL_PLANNER_MODE_DEFAULT: 1,
      CONVERSATIONAL_PLANNER_MODE_READ_ONLY: 2,
    }),
  ],
});

const cortexProto = create(FileDescriptorProtoSchema, {
  name: 'exa/cortex_pb/cortex.proto',
  package: 'exa.cortex_pb',
  messageType: [
    makeMessage('CascadeConfig', [makeField('planner_config', 1, 11, '.exa.cortex_pb.CascadePlannerConfig')]),
    makeMessage('CascadePlannerConfig', [
      makeField('conversational', 2, 11, '.exa.cortex_pb.CascadeConversationalPlannerConfig'),
      makeField('requested_model', 15, 11, '.exa.codeium_common_pb.ModelOrAlias'),
    ]),
    makeMessage('CascadeConversationalPlannerConfig', [
      makeField('planner_mode', 4, 14, '.exa.codeium_common_pb.ConversationalPlannerMode'),
      makeField('agentic_mode', 14, 8),
      makeField('override_workspace_dir_experimental_use_only', 17, 9),
    ]),
  ],
  enumType: [
    makeEnum('CortexTrajectorySource', {
      CORTEX_TRAJECTORY_SOURCE_UNSPECIFIED: 0,
      CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT: 1,
    }),
  ],
});

const chatClientProto = create(FileDescriptorProtoSchema, {
  name: 'exa/chat_client_server_pb/chat_client_server.proto',
  package: 'exa.chat_client_server_pb',
  enumType: [
    makeEnum('ChatClientRequestStreamClientType', {
      CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_UNSPECIFIED: 0,
      CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE: 1,
    }),
  ],
});

const lsProto = create(FileDescriptorProtoSchema, {
  name: 'exa/language_server_pb/language_server.proto',
  package: 'exa.language_server_pb',
  messageType: [
    makeMessage('StartCascadeRequest', [
      makeField('metadata', 1, 11, '.exa.codeium_common_pb.Metadata'),
      makeField('experiment_config', 2, 11, '.exa.codeium_common_pb.ExperimentConfig'),
      makeField('source', 4, 14, '.exa.cortex_pb.CortexTrajectorySource'),
      makeField('cascade_id', 7, 9),
      makeField('workspace_uris', 8, 9, undefined, 3),
    ]),
    makeMessage('StartCascadeResponse', [makeField('cascade_id', 1, 9)]),
    makeMessage('SendUserCascadeMessageRequest', [
      makeField('cascade_id', 1, 9),
      makeField('items', 2, 11, '.exa.codeium_common_pb.TextOrScopeItem', 3),
      makeField('metadata', 3, 11, '.exa.codeium_common_pb.Metadata'),
      makeField('experiment_config', 4, 11, '.exa.codeium_common_pb.ExperimentConfig'),
      makeField('cascade_config', 5, 11, '.exa.cortex_pb.CascadeConfig'),
      makeField('images', 6, 11, '.exa.codeium_common_pb.ImageData', 3),
      makeField('blocking', 8, 8),
      makeField('client_type', 11, 14, '.exa.chat_client_server_pb.ChatClientRequestStreamClientType'),
      makeField('message_origin', 18, 14, '.exa.language_server_pb.AgentMessageOrigin'),
    ]),
    makeMessage('SendUserCascadeMessageResponse', [makeField('queued', 1, 8)]),
  ],
  enumType: [
    makeEnum('AgentMessageOrigin', {
      AGENT_MESSAGE_ORIGIN_UNSPECIFIED: 0,
      AGENT_MESSAGE_ORIGIN_IDE: 1,
    }),
  ],
});

// ─────────────────────────────────────────────
// Registry (lazy singleton)
// ─────────────────────────────────────────────

let _registry = null;

function getRegistry() {
  if (!_registry) {
    const fds = create(FileDescriptorSetSchema, {
      file: [commonProto, cortexProto, chatClientProto, lsProto],
    });
    _registry = createFileRegistry(fds);
  }
  return _registry;
}

function getSchema(fullName) {
  const schema = getRegistry().getMessage(fullName);
  if (!schema) throw new Error(`Proto schema not found: ${fullName}`);
  return schema;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Encode a JSON-like object into binary protobuf for the given message type.
 * @param {string} messageName - Fully qualified protobuf message name
 * @param {object} data - JSON-compatible object matching the proto schema
 * @returns {Uint8Array} Binary protobuf bytes
 */
function encodeProto(messageName, data) {
  const schema = getSchema(messageName);
  const msg = create(schema, data);
  return toBinary(schema, msg);
}

/**
 * Decode binary protobuf into a JSON-like object.
 * @param {string} messageName - Fully qualified protobuf message name
 * @param {Uint8Array} bytes - Binary protobuf bytes
 * @returns {object} Decoded message object
 */
function decodeProto(messageName, bytes) {
  const schema = getSchema(messageName);
  return fromBinary(schema, bytes);
}

module.exports = { getRegistry, getSchema, encodeProto, decodeProto, create, toBinary, fromBinary };
