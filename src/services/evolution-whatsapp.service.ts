import { config } from "../config/index";

export interface WebhookConfig {
  webhookUrl: string;
  webhookByEvents: boolean;
  webhookEvents: string[];
}

export class EvolutionWhatsAppService {
  private readonly baseUrl: string;
  private readonly instanceName: string;
  private readonly instanceApiKey: string;
  private readonly globalApiKey: string;

  constructor() {
    this.baseUrl = config.EVOLUTION_API_URL;
    this.instanceName = config.EVOLUTION_INSTANCE_NAME;
    this.instanceApiKey = config.EVOLUTION_API_KEY;
    this.globalApiKey = config.EVOLUTION_GLOBAL_API_KEY;
  }

  /**
   * Helper to normalize Pakistani phones to Evolution format (923...)
   */
  public formatPhoneForWhatsApp(phone: string): string {
    // Remove all non-digits
    let cleaned = phone.replace(/\D/g, "");
    
    // Convert local 03 format to 923
    if (cleaned.startsWith("03") && cleaned.length === 11) {
      cleaned = "92" + cleaned.substring(1);
    }
    
    return cleaned;
  }

  /**
   * Send a text message to a WhatsApp number using the Instance API Key
   */
  public async sendTextMessage(phone: string, message: string): Promise<any> {
    if (this.instanceApiKey === "demo_instance_key" || !this.baseUrl) {
      console.log(`[WhatsApp Mock to ${phone}]: \n${message}`);
      return { status: "MOCK", externalId: "mock_" + Date.now() };
    }

    const formattedPhone = this.formatPhoneForWhatsApp(phone);
    const url = `${this.baseUrl}/message/sendText/${this.instanceName}`;

    const payload = {
      number: formattedPhone,
      options: {
        delay: 1200,
        presence: "composing",
        linkPreview: false
      },
      text: message
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": this.instanceApiKey
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Evolution API Error ${response.status}: ${errorText}`);
      }

      return await response.json();
    } catch (error: any) {
      console.error(`❌ Evolution WhatsApp failed to send to ${formattedPhone}:`, error.message);
      throw error;
    }
  }

  /**
   * Test the connection to the instance
   */
  public async testConnection(): Promise<boolean> {
    if (this.instanceApiKey === "demo_instance_key") return true;

    try {
      const url = `${this.baseUrl}/instance/connectionState/${this.instanceName}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "apikey": this.instanceApiKey
        }
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Configure Evolution Webhook for this instance
   * Typically requires Global API Key for instance-level config
   */
  public async configureWebhook(): Promise<any> {
    if (this.globalApiKey === "demo_global_key" || !this.baseUrl) {
      console.log(`[Evolution Mock]: Skipping webhook configuration for ${this.instanceName}`);
      return { success: true, mock: true };
    }

    const url = `${this.baseUrl}/webhook/set/${this.instanceName}`;
    const webhookUrl = config.EVOLUTION_WEBHOOK_URL;

    const payload: WebhookConfig = {
      webhookUrl: webhookUrl,
      webhookByEvents: false,
      webhookEvents: [
        "APPLICATION_STARTUP",
        "MESSAGES_UPSERT",
        "MESSAGES_UPDATE",
        "SEND_MESSAGE",
        "CONNECTION_UPDATE"
      ]
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": this.globalApiKey
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Evolution Webhook Config Error ${response.status}: ${errorText}`);
      }

      return await response.json();
    } catch (error: any) {
      console.error(`❌ Evolution Webhook Config failed:`, error.message);
      throw error;
    }
  }
}

export const evolutionService = new EvolutionWhatsAppService();
