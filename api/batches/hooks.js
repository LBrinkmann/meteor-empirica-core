import { config } from "../../server";
import { GameLobbies } from "../game-lobbies/game-lobbies";
import { Games } from "../games/games";
import { Players } from "../players/players.js";
import { Treatments } from "../treatments/treatments";
import { Batches } from "./batches";

// Create GameLobbies
Batches.after.insert(function(userId, batch) {

  const treatmentsFactors = batch.simpleConfig.treatments.map(t => Treatments.findOne(t._id).factorsObject());
  config.batchInit(batch, treatmentsFactors);

  let gameLobbies = [];
  switch (batch.assignment) {
    case "simple":
      _.times(batch.simpleConfig.count, index => {
        const treatment = Random.choice(batch.simpleConfig.treatments);
        const { _id: treatmentId, lobbyConfigId } = treatment;
        gameLobbies.push({
          treatmentId,
          lobbyConfigId,
          index
        });
      });
      break;
    case "complete":
      batch.completeConfig.treatments.forEach(
        ({ count, _id, lobbyConfigId }) => {
          _.times(count, () => {
            gameLobbies.push({ treatmentId: _id, lobbyConfigId });
          });
        }
      );

      gameLobbies = _.shuffle(gameLobbies);
      gameLobbies.forEach((l, index) => {
        l.index = index;
      });
      break;
    default:
      console.error("Batches.after: unknown assignment: " + batch.assignment);
      break;
  }

  const gameLobbyIds = gameLobbies.map(l => {
    l._id = Random.id();
    l.status = batch.status;
    l.batchId = batch._id;

    // This is trully horrific. Sorry.
    // The debug mode is assigned asynchronously onto the batch, which might happen
    // just as this on insert hook is called. Sorry.
    const batchUpdated = Batches.findOne(batch._id);
    l.debugMode = batchUpdated.debugMode;

    const treatment = Treatments.findOne(l.treatmentId);
    l.availableCount = treatment.factor("playerCount").value;
    const botsCountCond = treatment.factor("botsCount");
    if (botsCountCond) {
      const botsCount = botsCountCond.value;
      if (botsCount > l.availableCount) {
        throw "Trying to create a game with more bots than players";
      }
      if (botsCount === l.availableCount) {
        throw "Creating a game with only bots...";
      }
      const botNames = config.bots && _.keys(config.bots);
      if (!config.bots || botNames.length === 0) {
        throw "Trying to create a game with bots, but no bots defined";
      }

      l.playerIds = [];
      _.times(botsCount, () => {
        const params = {
          id: Random.id(),
          gameLobbyId: l._id,
          readyAt: new Date(),
          bot: _.shuffle(botNames)[0]
        };
        console.info("Creating bot:", params);
        const playerId = Players.insert(params);
        l.playerIds.push(playerId);
      });
      l.queuedPlayerIds = l.playerIds;
    }

    return GameLobbies.insert(l);
  });

  Batches.update(batch._id, { $set: { gameLobbyIds } });
});

// Update status on Games and GameLobbies
Batches.after.update(
  function(userId, { _id: batchId, status }, fieldNames, modifier, options) {
    if (!fieldNames.includes("status")) {
      return;
    }

    [Games, GameLobbies].forEach(coll => {
      coll.update({ batchId }, { $set: { status } }, { multi: true });
    });
  },
  { fetchPrevious: false }
);

// If batch cancelled, add exit info to players
Batches.after.update(
  function(userId, { _id: batchId, status }, fieldNames, modifier, options) {
    if (!fieldNames.includes("status")) {
      return;
    }

    if (status === "cancelled") {
      const games = Games.find({ batchId }).fetch();
      const gameLobbies = GameLobbies.find({ batchId }).fetch();
      const gplayerIds = _.flatten(_.pluck(games, "playerIds"));
      const glplayerIds = _.flatten(_.pluck(gameLobbies, "playerIds"));
      const playerIds = _.union(gplayerIds, glplayerIds);
      Players.update(
        { _id: { $in: playerIds } },
        { $set: { exitStatus: "gameCancelled", exitAt: new Date() } },
        { multi: true }
      );
    }
  },
  { fetchPrevious: false }
);
