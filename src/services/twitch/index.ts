import tmi from "tmi.js";
import twitchOptions from "./twitchOptions";
import config from "../../config";
import CommandContext from "../../beastie/commands/utils/commandContext";
import { CommandModule, determineCommand } from "../../beastie/commands";
import { checkForRaidMessage, endRaid, startRaiding } from "../../beastie/raid";
import {
  awesomenessInterval,
  awesomenessIntervalAmount,
  beastieConnectMessage,
  beastieDisconnectMessage,
  discordInterval,
  discordIntervalMessage,
  patreonInterval,
  patreonIntervalMessage,
  subscribeInterval,
  subscribeIntervalMessage,
  POST_EVENT,
  raidMessage,
  raidTimer
} from "../../utils/values";
import { updateChattersAwesomeness } from "../../utils";
import twitchPosts from "./twitchPosts";
import { BeastieLogger } from "../../utils/Logging";
import { getParameters } from "../../utils/getParameters";

export default class BeastieTwitchService {
  client: tmi.Client;

  broadcasterUsername: string;

  // raid feature
  activeRaid: boolean;
  raidMessage: string;
  raidTeam: Array<number>;
  hostedChannel: string;
  raidReward: number;

  // interval messages feature
  awesomenessInterval: NodeJS.Timeout;
  awesomenessIntervalAmount: number;
  discordInterval: NodeJS.Timeout;
  patreonInterval: NodeJS.Timeout;
  subscribeInterval: NodeJS.Timeout;

  messageQueue: string[] = [];
  messageQueueLimit: number = 1000 * 1.5;
  messageQueueTimeout: NodeJS.Timeout = null;

  constructor() {
    // @ts-ignore
    this.client = new tmi.Client(twitchOptions);
    this.broadcasterUsername = config.BROADCASTER_USERNAME.toLocaleLowerCase();
    this.awesomenessIntervalAmount = awesomenessIntervalAmount;
    this.activeRaid = false;
    this.raidMessage = raidMessage;
    this.raidTeam = [];
    this.hostedChannel = "";
    this.raidReward = 0;

    // Event Listeners
    this.client.on("message", async (channel, tags, message, self) => {
      if (!self) await this.onMessage(channel, tags, message);
    });

    // TODO: SOMETHING IN HERE IS ERRORING WHEN BEASTIE STARTS UP AND WE ARE CURRENTLY HOSTING SOMEONE
    // this.client.on("hosting", async (channel, target, viewers) => {
    //   try {
    //     await this.onHosting(target, viewers);
    //   } catch (e) {
    //     BeastieLogger.warn(`Failed handling hosting: ${e}`);
    //   }
    // });

    this.client.on("connected", async () => {
      BeastieLogger.info(`Beastie has connected to twitch`);
      await this.onConnect();
    });

    this.client.on("disconnected", async () => {
      BeastieLogger.info("BEASTIE HAS BEEN DISCONNECTED FROM TWITCH");
      await this.onDisconnect();
    });
  }

  public async destroy() {
    BeastieLogger.info("SHUTTING DOWN TWITCH ON SIGINT");
    await this.onSIGINT();
  }

  private sayQueue = async () => {
    if (this.messageQueueTimeout) {
      return;
    }
    this.messageQueueTimeout = null;

    let msg = this.messageQueue.pop();
    if (msg) {
      try {
        await this.client.say(this.broadcasterUsername, msg);
      } catch (e) {
        BeastieLogger.warn(`Failed to send message: ${e}`);
      }

      this.messageQueueTimeout = setTimeout(() => {
        this.messageQueueTimeout = null;
        this.sayQueue();
      }, this.messageQueueLimit);
    }
  };

  // BeastieTwitchClient Actions
  private say = async (msg: string | string[]) => {
    if (Array.isArray(msg)) {
      msg.forEach(m => {
        this.messageQueue.push(m);
      });
    } else {
      this.messageQueue.push(msg);
    }

    await this.sayQueue();
  };

  public post = (event, name) => {
    const msg = twitchPosts(event, name);
    return this.say(msg);
  };

  public toggleStreamIntervals = live => {
    if (live) {
      BeastieLogger.info("Stream intervals running...");
      if (this.awesomenessInterval === undefined)
        this.awesomenessInterval = setInterval(() => {
          updateChattersAwesomeness(
            this.awesomenessIntervalAmount
          ).catch(error =>
            BeastieLogger.error(`updateChattersAwesomeness ERROR ${error}`)
          );
        }, awesomenessInterval);
      if (this.discordInterval === undefined)
        this.discordInterval = setInterval(async () => {
          await this.say(discordIntervalMessage);
        }, discordInterval);
      if (this.patreonInterval === undefined)
        this.patreonInterval = setInterval(async () => {
          await this.say(patreonIntervalMessage);
        }, patreonInterval);
      if (this.subscribeInterval === undefined) {
        setTimeout(() => {
          console.log("subscribeInterval set now");
          this.subscribeInterval = setInterval(async () => {
            await this.say(subscribeIntervalMessage);
          }, subscribeInterval);
        }, subscribeInterval / 2);
      }
    } else {
      clearInterval(this.awesomenessInterval);
      clearInterval(this.discordInterval);
      clearInterval(this.patreonInterval);
      clearInterval(this.subscribeInterval);
    }
  };

  // Event Handlers
  private onConnect = async () => {
    await this.client.join(this.broadcasterUsername);
    await this.say(beastieConnectMessage);
  };

  private onDisconnect = async () => {
    clearTimeout(this.messageQueueTimeout);
    this.messageQueueTimeout = null;
  };

  private onSIGINT = async () => {
    await this.say(beastieDisconnectMessage);
    clearTimeout(this.messageQueueTimeout);
    this.messageQueueTimeout = null;
    await this.client.disconnect();
  };

  private onMessage = async (channel, tags, message) => {
    if (!message.startsWith("!")) {
      // if (this.activeRaid && this.hostedChannel !== "") {
      //   checkForRaidMessage(this, channel, tags, message);
      // }
      return;
    }
    const [command, ...parameters] = getParameters(message);
    const [para1, para2] = parameters;

    const badges = tags.badges ? Object.keys(tags.badges) : [];
    if (badges.includes("broadcaster")) badges.push("moderator");

    const commandModule: CommandModule = determineCommand(
      command.slice(1),
      badges
    );
    if (commandModule) {
      try {
        const response: string | void = await commandModule.execute(
          new CommandContext({
            platform: "twitch",
            client: this,
            message,
            command,
            para1,
            para2,
            parameters,
            username: tags.username,
            displayName: tags["display-name"],
            twitchId: tags["user-id"],
            roles: badges
          })
        );

        if (response) await this.say(response);
      } catch (reason) {
        BeastieLogger.warn(`Failed to execute command because: ${reason}`);
      }
    }
  };

  private onHosting = async (target, viewers) => {
    if (!this.activeRaid) {
      await this.post(POST_EVENT.TWITCH_HOSTING, target);
      return;
    }

    //const startResponse = startRaiding(this, target, viewers);
    //await this.say(startResponse);

    // setTimeout(async () => {
    //   try {
    //     const endResponse = endRaid(this.client, target, this.raidReward);
    //     this.activeRaid = endResponse.activeRaid;
    //     this.raidTeam = endResponse.raidTeam;
    //     this.raidReward = endResponse.raidReward;
    //     await this.say(endResponse.messages);
    //   } catch (e) {
    //     BeastieLogger.warn(`Failed to end raid: ${e}`);
    //   }
    // }, raidTimer);
  };
}
