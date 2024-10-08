import express from "express";
import fileUpload from "express-fileupload";
import { Transaction, Account, BadTransaction } from "../../types/types";
import cors from "cors";
import { createRequestHandler } from "@remix-run/express";
import { PrismaClient } from "@prisma/client";
import { redisClient } from "./redis/redis-client";
import { config } from "../../config/config";
import type { ServerBuild } from "@remix-run/server-runtime";
import { fileURLToPath } from "url";
import Joi from "joi";
import fs from "fs";
import path from "path";
import Papa from "papaparse";
import dotenv from "dotenv";
import * as serverBuild from "../../build/server.js";

const build = serverBuild as unknown as ServerBuild;
const headers = ["accountName", "cardNumber", "amount", "type", "description", "targetCardNumber"];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prisma = new PrismaClient();
const app = express();

dotenv.config({
  path: config.NODE_ENV === "production" ? ".env.production" : ".env.local",
});

app.use(fileUpload());
app.use(express.json());

const transactionSchema = Joi.object({
  accountName: Joi.string().required().label("Account Name"),
  cardNumber: Joi.string().required().label("Card Number"),
  amount: Joi.string().required().label("Amount"),
  type: Joi.string().valid("Credit", "Debit", "Transfer").insensitive().default("Unknown").label("Transaction Type"),
  description: Joi.string().optional().label("Description"),
  targetCardNumber: Joi.string().optional().label("Target Card Number"),
  accountId: Joi.string().optional().label("Account ID"),
});

app.post("/upload", async (req, res) => {
  if (!req.files || Object.keys(req.files).length === 0) {
    return res.status(400).send("No files were uploaded.");
  }

  const file = req.files.file as fileUpload.UploadedFile;
  const filePath = path.join(__dirname, "uploads", file.name);

  await fs.promises.writeFile(filePath, file.data);

  const csvContent = await fs.promises.readFile(filePath, "utf-8");

  const parsedData = Papa.parse<string[]>(csvContent, {
    header: false,
    skipEmptyLines: true,
  }).data;

  const existingAccountsData = await redisClient.get("accounts");
  const existingBadTransactionsData = await redisClient.get("badTransactions");

  const accounts: Account[] = existingAccountsData ? JSON.parse(existingAccountsData) : [];
  const badTransactions: BadTransaction[] = existingBadTransactionsData ? JSON.parse(existingBadTransactionsData) : [];

  parsedData.forEach((transaction: string[], index) => {
    let [accountName, cardNumber, amount, type, description, targetCardNumber] = transaction;
    const accountId = `${accountName.replace(/\s+/g, "_")}_${cardNumber.trim()}`;
    const typeVals = ["Credit", "Debit", "Transfer"];
    if (!typeVals.includes(type)) {
      type = "Unknown";
    }

    const transactionObject: Transaction = {
      accountName,
      accountId,
      cardNumber,
      amount,
      type,
      description,
      targetCardNumber: targetCardNumber ? String(targetCardNumber) : undefined,
    };

    const { error, value } = transactionSchema.validate(transactionObject, { abortEarly: false });

    if (error) {
      badTransactions.push({
        error: error.details.map((detail) => detail.message).join(", "),
        rawData: transactionObject,
        transactionAmount: transactionObject.amount || "0",
        cardNumber: transactionObject.cardNumber || "Unknown",
        accountName: transactionObject.accountName || "Unknown",
        description: transactionObject.description || "No Description",
        accountId: transactionObject.accountId || "No ID",
        type: transactionObject.type || "Unknown",
      });
      console.log(`Invalid transaction at row ${index + 1}: ${error.message}, got ${type}`);

      return;
    }

    let account = accounts.find((acc) => acc.accountId === transactionObject.accountId);
    if (!account) {
      account = {
        accountName: transactionObject.accountName,
        accountId: transactionObject.accountId,
        cards: {},
        balance: 0,
      };
      accounts.push(account);
    }

    const numericAmount = parseFloat(transactionObject.amount);
    account.cards[transactionObject.cardNumber] = (account.cards[transactionObject.cardNumber] || 0) + numericAmount;
    account.balance += numericAmount;

    redisClient.rpush(`transactions:${transactionObject.accountId}`, JSON.stringify(transactionObject));
  });

  await redisClient.set("accounts", JSON.stringify(accounts));
  await redisClient.set("badTransactions", JSON.stringify(badTransactions));

  res.send({ message: "File uploaded and transactions processed.", accounts, badTransactions });
});
app.get("/accounts/:accountId", async (req, res) => {
  const { accountId } = req.params;

  const accountData = await redisClient.get(`accounts`);
  const accounts = accountData ? JSON.parse(accountData) : [];

  const account = accounts.find((acc: Account) => acc.accountId === accountId);

  if (account) {
    res.json(account);
  } else {
    res.status(404).json({ message: "Account not found" });
  }
});

app.get("/accounts/:accountId/transactions", async (req, res) => {
  const { accountId } = req.params;

  console.log(`Fetching transactions for account: ${accountId}`);

  const redisKey = `transactions:${accountId}`;
  const transactions = await redisClient.lrange(redisKey, 0, -1); // fetch all transactions

  console.log("Fetched transactions:", transactions);

  if (transactions && transactions.length > 0) {
    const parsedTransactions = transactions.map((tx) => JSON.parse(tx));
    res.json(parsedTransactions);
  } else {
    res.status(404).json({ message: `No transactions found for account ${accountId}` });
  }
});

app.get("/report", async (req, res) => {
  try {
    // fetch accounts and badTransactions from Redis
    const accountsData = await redisClient.get("accounts");
    const badTransactionsData = await redisClient.get("badTransactions");

    // parse the data retrieved from Redis
    const accounts: Account[] = accountsData ? JSON.parse(accountsData) : [];
    const badTransactions: BadTransaction[] = badTransactionsData ? JSON.parse(badTransactionsData) : [];

    const collections = accounts.filter((account) => Object.values(account.cards).some((balance) => balance < 0));

    res.json({
      accounts,
      badTransactions,
      collections,
    });
  } catch (error) {
    console.error("Error fetching report data:", error);
    res.status(500).json({ error: "Failed to fetch report" });
  }
});

app.post("/reset", async (req, res) => {
  try {
    await redisClient.flushall();

    const uploadsDir = path.join(__dirname, "uploads");
    fs.readdir(uploadsDir, (err, files) => {
      if (err) console.error("Error reading uploads directory:", err);

      files.forEach((file) => {
        const filePath = path.join(uploadsDir, file);
        fs.unlink(filePath, (err) => {
          if (err) console.error("Error deleting file:", err);
        });
      });
    });

    console.log("System reset successful. All data cleared.");
    return res.status(200).send("System reset successful.");
  } catch (error) {
    console.error("Error resetting the system:", error);
    res.status(500).send("System reset failed.");
  }
});

app.all(
  "*",
  createRequestHandler({
    build: build,
    getLoadContext() {
      return { redisClient };
    },
  })
);

app.listen(4000, () => {
  console.log("Server running on port 4000");
});
