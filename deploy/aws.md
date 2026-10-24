# Run GS Kanban on AWS with HTTPS

This puts the board on one small AWS Lightsail server (an EC2 instance works the same way). Caddy sits in front of the app and gets a free HTTPS certificate from Let's Encrypt, then renews it on its own.

You need: an AWS account, and a web address you can point at the server, such as `kanban.gordon-systems.com` (whoever manages your company's DNS can add it).

## 1. Create the server

1. In the AWS console open **Lightsail**, then **Create instance**.
2. Pick **Linux/Unix**, **OS Only**, **Ubuntu 24.04 LTS**.
3. Pick the **2 GB RAM** plan (about $12 a month). 1 GB also works for a small team.
4. Name it `gs-kanban` and create it.
5. Under **Networking**: attach a **static IP**, and add firewall rules for **HTTPS (443)** and **HTTP (80)**. Keep SSH (22).
6. Under **Snapshots**, turn on **automatic snapshots**. This is your daily backup of the database.

On EC2 instead: launch Ubuntu 24.04 (t3.small), attach an Elastic IP, allow ports 22, 80 and 443 in the security group, and turn on daily snapshots with Data Lifecycle Manager.

## 2. Point your web address at it

Add a DNS **A record** for your chosen name (for example `kanban`) pointing to the static IP. Wait until `ping kanban.gordon-systems.com` shows that IP.

## 3. Install Docker

Connect with the browser SSH button in Lightsail, then run:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

Connect again so the new group applies.

## 4. Get the code onto the server

The repo is private, so give the server read-only access with a deploy key:

```sh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

In GitHub, open the repo's **Settings > Deploy keys > Add deploy key**, paste that line, and leave **write access** off. Then:

```sh
git clone git@github.com:bhenry-GS/GS-Kanban.git gs-kanban
cd gs-kanban
cp .env.example .env
nano .env        # set DOMAIN, and the D-Tools values if you have them
```

## 5. Start it

```sh
docker compose up -d --build
```

Open `https://<your domain>`. The first page asks you to create the admin account. Do that right away, before sharing the address.

## Updating

```sh
cd ~/gs-kanban && git pull && docker compose up -d --build
```

## Useful commands

- See logs: `docker compose logs -f app`
- Restart: `docker compose restart`
- Copy the database off the server: `docker compose cp app:/data/kanban.db ./kanban-backup.db`
