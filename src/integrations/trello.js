import axios from 'axios';
import dotenv from 'dotenv';
import { loadProjectConfig } from '../config/index.js';

dotenv.config();

const TRELLO_API_BASE_URL = 'https://api.trello.com/1';

/**
 * Class representing the Trello Integration Service.
 * Follows Object-Oriented Principles to allow multi-tenant instantiation,
 * dependency injection, and clean separation of concerns.
 */
export class TrelloIntegration {
  /**
   * Initializes the Trello service.
   * @param {Object} [options={}] - Optional configuration overrides.
   * @param {string} [options.apiKey] - Trello API key (defaults to process.env.TRELLO_API_KEY).
   * @param {string} [options.token] - Trello token (defaults to process.env.TRELLO_TOKEN).
   * @param {string} [options.boardId] - Target Trello board ID (defaults to project.config.json).
   * @param {number} [options.timeout=10000] - Request timeout in milliseconds.
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.TRELLO_API_KEY;
    this.token = options.token || process.env.TRELLO_TOKEN;
    this.boardId = options.boardId || this._resolveDefaultBoardId();
    this.timeout = options.timeout || 10000;

    this.client = axios.create({
      baseURL: TRELLO_API_BASE_URL,
      timeout: this.timeout,
      headers: {
        'Accept': 'application/json',
      },
    });

    // Request interceptor to automatically attach authentication credentials
    this.client.interceptors.request.use(
      (config) => {
        config.params = {
          ...config.params,
          key: this.apiKey,
          token: this.token,
        };
        return config;
      },
      (error) => Promise.reject(error)
    );
  }

  /**
   * Internal helper to load the default board ID from project config.
   * @private
   * @returns {string|null}
   */
  _resolveDefaultBoardId() {
    try {
      const config = loadProjectConfig();
      return config.trelloBoardId || null;
    } catch {
      return null;
    }
  }

  /**
   * Validates required API credentials before dispatching requests.
   * @throws {Error} If credentials or boardId are missing.
   */
  validateCredentials() {
    if (!this.apiKey || !this.token) {
      throw new Error(
        '[TrelloIntegration] Missing credentials: Both TRELLO_API_KEY and TRELLO_TOKEN must be configured in environment variables or constructor.'
      );
    }
  }

  /**
   * Fetches raw board data including lists, cards, and members in an optimized single API call.
   * 
   * @param {string} [targetBoardId] - Board ID (defaults to instance boardId).
   * @returns {Promise<Object>} Raw Trello API response.
   */
  async getRawBoardData(targetBoardId = this.boardId) {
    this.validateCredentials();
    const boardId = targetBoardId || this.boardId;

    if (!boardId) {
      throw new Error('[TrelloIntegration] Board ID is required to fetch board data.');
    }

    try {
      const response = await this.client.get(`/boards/${boardId}`, {
        params: {
          fields: 'name,desc,url,closed',
          lists: 'open',
          list_fields: 'name,closed,pos',
          cards: 'open',
          card_fields: 'name,desc,due,dueComplete,idList,idMembers,labels,shortUrl,closed,dateLastActivity',
          members: 'all',
          member_fields: 'fullName,username,avatarUrl',
        },
      });

      return response.data;
    } catch (error) {
      this._handleApiError('getRawBoardData', error, { boardId });
    }
  }

  /**
   * Extracts and normalizes Trello board data into a clean, structured JSON schema
   * optimized for consumption by the AI Agent Executor (token-efficient, rich metadata).
   * 
   * @param {string} [targetBoardId] - Optional board ID.
   * @returns {Promise<Object>} Structured board audit payload.
   */
  async getStructuredBoardData(targetBoardId = this.boardId) {
    const rawData = await this.getRawBoardData(targetBoardId);

    try {
      // 1. Build lookup dictionaries for O(1) correlation
      const memberMap = new Map();
      (rawData.members || []).forEach((member) => {
        memberMap.set(member.id, {
          id: member.id,
          fullName: member.fullName,
          username: member.username,
        });
      });

      const listMap = new Map();
      (rawData.lists || []).forEach((list) => {
        listMap.set(list.id, list.name);
      });

      const now = new Date();
      let completedCount = 0;
      let overdueCount = 0;
      let pendingCount = 0;
      const cardsByList = {};

      // 2. Normalize and enrich cards
      const normalizedCards = (rawData.cards || []).map((card) => {
        const listName = listMap.get(card.idList) || 'Unknown List';
        cardsByList[listName] = (cardsByList[listName] || 0) + 1;

        const hasDue = Boolean(card.due);
        const dueDate = hasDue ? new Date(card.due) : null;
        const isComplete = Boolean(card.dueComplete);
        const isOverdue = hasDue && !isComplete && dueDate < now;

        // Calculate card lifecycle status
        let status = 'pending';
        if (isComplete) {
          status = 'completed';
          completedCount++;
        } else if (isOverdue) {
          status = 'overdue';
          overdueCount++;
        } else {
          status = 'in_progress';
          pendingCount++;
        }

        // Map assigned members
        const assignees = (card.idMembers || [])
          .map((memberId) => memberMap.get(memberId))
          .filter(Boolean);

        // Normalize labels
        const labels = (card.labels || []).map((label) => ({
          id: label.id,
          name: label.name || label.color || 'unnamed',
          color: label.color,
        }));

        return {
          id: card.id,
          name: card.name,
          description: card.desc || '',
          list: {
            id: card.idList,
            name: listName,
          },
          status,
          dueDate: card.due || null,
          dueComplete: isComplete,
          isOverdue,
          assignees,
          labels,
          url: card.shortUrl,
          lastActivity: card.dateLastActivity,
        };
      });

      // 3. Normalized structure
      return {
        board: {
          id: rawData.id,
          name: rawData.name,
          description: rawData.desc || '',
          url: rawData.url,
        },
        lists: (rawData.lists || []).map((list) => ({
          id: list.id,
          name: list.name,
          cardCount: cardsByList[list.name] || 0,
        })),
        members: Array.from(memberMap.values()),
        cards: normalizedCards,
        metrics: {
          totalCards: normalizedCards.length,
          completedCards: completedCount,
          overdueCards: overdueCount,
          pendingCards: pendingCount,
          cardsByList,
          extractedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      console.error('[TrelloIntegration] Normalization error:', error.message);
      throw new Error(`[TrelloIntegration] Failed to normalize board data: ${error.message}`);
    }
  }

  /**
   * Fetches only active lists from the board.
   * @param {string} [targetBoardId]
   * @returns {Promise<Array>}
   */
  async getLists(targetBoardId = this.boardId) {
    this.validateCredentials();
    const boardId = targetBoardId || this.boardId;
    try {
      const response = await this.client.get(`/boards/${boardId}/lists`, {
        params: { filter: 'open', fields: 'name,closed,pos' },
      });
      return response.data;
    } catch (error) {
      this._handleApiError('getLists', error, { boardId });
    }
  }

  /**
   * Fetches open cards belonging to a specific list.
   * @param {string} listId
   * @returns {Promise<Array>}
   */
  async getCardsByList(listId) {
    this.validateCredentials();
    try {
      const response = await this.client.get(`/lists/${listId}/cards`, {
        params: {
          fields: 'name,desc,due,dueComplete,idMembers,labels,shortUrl',
          members: 'true',
          member_fields: 'fullName,username',
        },
      });
      return response.data;
    } catch (error) {
      this._handleApiError('getCardsByList', error, { listId });
    }
  }

  /**
   * Modifies an existing Trello card based on validated parameters (e.g., due date, moving list).
   * Protected with try/catch so API issues do not crash the server.
   * 
   * @param {Object} trelloExecutionParams - Validated parameters from Agente Aprobador.
   * @param {string} [trelloExecutionParams.idCard] - ID of the target card.
   * @param {string} [trelloExecutionParams.cardId] - Alternative ID of target card.
   * @param {string|null} [trelloExecutionParams.due] - New due date in ISO format.
   * @param {string|null} [trelloExecutionParams.idList] - Destination list ID to move the card.
   * @param {Array<string>|string} [trelloExecutionParams.idMembers] - Member IDs assigned to the card.
   * @returns {Promise<Object>} Execution result { success: boolean, data?: Object, error?: string }
   */
  async updateCard(trelloExecutionParams = {}) {
    const cardId = trelloExecutionParams.idCard || trelloExecutionParams.cardId;

    if (!cardId) {
      console.error('[TrelloIntegration.updateCard] ⚠️ Parámetro idCard faltante en los parámetros de ejecución.');
      return {
        success: false,
        error: 'El parámetro idCard es obligatorio para ejecutar la modificación en Trello.',
      };
    }

    try {
      this.validateCredentials();

      const queryParams = {};
      if (trelloExecutionParams.due !== undefined) queryParams.due = trelloExecutionParams.due;
      if (trelloExecutionParams.idList) queryParams.idList = trelloExecutionParams.idList;
      if (trelloExecutionParams.idMembers) {
        queryParams.idMembers = Array.isArray(trelloExecutionParams.idMembers)
          ? trelloExecutionParams.idMembers.join(',')
          : trelloExecutionParams.idMembers;
      }
      if (trelloExecutionParams.name) queryParams.name = trelloExecutionParams.name;
      if (trelloExecutionParams.desc) queryParams.desc = trelloExecutionParams.desc;

      console.log(`[TrelloIntegration] 📡 Ejecutando modificación para tarjeta "${cardId}"...`, queryParams);

      const response = await this.client.put(`/cards/${cardId}`, null, {
        params: queryParams,
      });

      console.log(`[TrelloIntegration] ✅ Tarjeta "${cardId}" modificada exitosamente en Trello.`);
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      const errorDetails = error.response?.data || error.message;
      console.error(
        `[TrelloIntegration.updateCard] ⚠️ Error al modificar la tarjeta "${cardId}" en Trello (Status: ${error.response?.status || 'N/A'}):`,
        errorDetails
      );
      return {
        success: false,
        error: typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails),
      };
    }
  }

  /**
   * Internal error handler formatting API issues consistently.
   * @private
   */
  _handleApiError(method, error, context = {}) {
    const status = error.response?.status;
    const errorDetails = error.response?.data || error.message;
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    console.error(
      `[TrelloIntegration.${method}] Request failed (Status: ${status || 'N/A'}, Context: ${contextStr}):`,
      errorDetails
    );

    const customError = new Error(
      `[TrelloIntegration.${method}] API Error (${status || 'Network/Client Error'}): ${
        typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails)
      }`
    );
    customError.status = status;
    customError.context = context;
    throw customError;
  }
}

// Default singleton instance configured from current environment/config
export const trelloIntegration = new TrelloIntegration();

/**
 * Convenience export for Agent Executor workflows:
 * Extracts structured board data in a single call.
 * 
 * @param {string} [boardId] - Optional specific board ID.
 * @returns {Promise<Object>} Clean, structured JSON with lists, cards, assignees, labels, and metrics.
 */
export const fetchTrelloBoardSnapshot = async (boardId) => {
  return trelloIntegration.getStructuredBoardData(boardId);
};

/**
 * Convenience export to apply approved card modifications in Trello.
 * 
 * @param {Object} trelloExecutionParams - Validated parameters ({ idCard, due, idList, ... }).
 * @returns {Promise<Object>} Result object { success: boolean, data?: Object, error?: string }.
 */
export const ejecutarModificacionTrello = async (trelloExecutionParams) => {
  return trelloIntegration.updateCard(trelloExecutionParams);
};

export default trelloIntegration;
