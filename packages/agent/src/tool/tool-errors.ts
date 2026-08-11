import type { ToolErrorDefinition } from "./tool-contract.js";

export const DOCUMENT_ERRORS = [
  {
    code: "DOCUMENT_NOT_FOUND",
    description: "找不到指定项目文档。",
    recovery: "先调用 list_project_documents 获取当前文档路径。",
  },
  {
    code: "PATH_OUTSIDE_PROJECT",
    description: "路径不在当前项目 manuscript 目录内。",
    recovery: "使用 manuscript 下的项目相对路径。",
  },
] as const satisfies readonly ToolErrorDefinition[];

export const APPROVAL_ERRORS = [
  {
    code: "USER_APPROVAL_REQUIRED",
    description: "当前环境不能取得所需用户审批。",
    recovery: "让用户在交互界面批准本次调用。",
  },
  {
    code: "USER_REJECTED",
    description: "用户拒绝了本次调用。",
    recovery: "停止修改，不得绕过审批。",
  },
] as const satisfies readonly ToolErrorDefinition[];

export const WRITE_DOCUMENT_ERRORS = [
  ...DOCUMENT_ERRORS,
  {
    code: "DOCUMENT_ALREADY_EXISTS",
    description: "目标文档已经存在但没有明确覆盖意图。",
    recovery: "只有用户明确要求覆盖时才设置 overwrite=true。",
  },
  ...APPROVAL_ERRORS,
] as const satisfies readonly ToolErrorDefinition[];

export const HISTORY_ERRORS = [
  {
    code: "HISTORY_MESSAGE_NOT_FOUND",
    description: "消息不存在、未关闭或不属于当前 Conversation。",
    recovery: "重新调用 search_conversation_history 获取当前 Message ID。",
  },
  {
    code: "HISTORY_UNAVAILABLE",
    description: "当前任务没有历史查询能力。",
    recovery: "使用累计摘要继续，或停止历史查询。",
  },
] as const satisfies readonly ToolErrorDefinition[];

export const KNOWLEDGE_ERRORS = [
  {
    code: "MATERIAL_NOT_FOUND",
    description: "当前项目中找不到指定资料。",
    recovery: "调用 list_materials 重新选择资料。",
  },
  {
    code: "MATERIAL_NOT_INDEXED",
    description: "指定资料尚未完成有效索引。",
    recovery: "等待索引完成，或要求用户重建索引。",
  },
  {
    code: "KNOWLEDGE_CHUNK_NOT_FOUND",
    description: "当前项目中找不到指定资料片段。",
    recovery: "重新调用 search_knowledge 获取当前 Chunk ID。",
  },
  {
    code: "CHUNK_SOURCE_MISMATCH",
    description: "资料片段不属于指定资料。",
    recovery: "原样使用同一搜索结果中的 title 和 chunkId。",
  },
] as const satisfies readonly ToolErrorDefinition[];
