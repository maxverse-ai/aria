import { useCallback, useEffect, useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Section } from "@astryxdesign/core/Section";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowLeftIcon,
  BoltIcon,
  CommandLineIcon,
  PauseIcon,
  PlayIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type { BotInfo, ProfileInfo } from "@/lib/types";
import { ConfigView } from "./ConfigView";

function uptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

export function ProfileDetail({ profile, onBack }: { profile: string; onBack: () => void }) {
  const [info, setInfo] = useState<ProfileInfo | null>(null);
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const showToast = useToast();

  const loadRuntime = useCallback(async () => {
    const [profileData, botData] = await Promise.all([
      apiGet<{ profiles: ProfileInfo[] }>("/api/profiles").catch(() => ({ profiles: [] })),
      apiGet<{ bots: BotInfo[] }>("/api/bots").catch(() => ({ bots: [] })),
    ]);
    setInfo(profileData.profiles.find((entry) => entry.name === profile) ?? null);
    setBots(botData.bots.filter((bot) => bot.profileName === profile));
  }, [profile]);

  useEffect(() => {
    void loadRuntime();
    const timer = setInterval(() => void loadRuntime(), 5_000);
    return () => clearInterval(timer);
  }, [loadRuntime]);

  async function confirmStop() {
    setStopping(true);
    try {
      await apiPost("/api/profiles/stop", { profile });
      showToast({ body: `${profile} 已停止` });
      setConfirm(false);
      setTimeout(() => void loadRuntime(), 500);
    } catch (cause) {
      showToast({ body: String((cause as Error).message ?? cause), type: "error" });
    } finally {
      setStopping(false);
    }
  }

  async function start() {
    setStarting(true);
    try {
      await apiPost("/api/profiles/start", { profile });
      showToast({ body: `${profile} 已启动` });
      setTimeout(() => void loadRuntime(), 500);
    } catch (cause) {
      showToast({ body: String((cause as Error).message ?? cause), type: "error" });
    } finally {
      setStarting(false);
    }
  }

  const running = info?.running ?? bots.length > 0;
  const longestUptime = bots.reduce((max, bot) => Math.max(max, bot.uptimeMs), 0);

  return (
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={6}>
            <VStack gap={4}>
              <Button
                label="返回工作台"
                variant="ghost"
                size="sm"
                icon={<Icon icon={ArrowLeftIcon} size="sm" />}
                onClick={onBack}
              />
              <HStack gap={4} hAlign="between" vAlign="center" wrap="wrap">
                <VStack gap={1}>
                  <Text type="supporting" color="accent" weight="semibold">AGENT WORKSPACE</Text>
                  <Heading level={1}>{profile}</Heading>
                  <Text color="secondary">运行状态、渠道连接和全部行为设置。</Text>
                </VStack>
                {running ? (
                  <Button
                    label="停止 Agent"
                    variant="destructive"
                    icon={<Icon icon={PauseIcon} size="sm" />}
                    onClick={() => setConfirm(true)}
                  />
                ) : (
                  <Button
                    label="启动 Agent"
                    variant="primary"
                    icon={<Icon icon={PlayIcon} size="sm" />}
                    isLoading={starting}
                    isDisabled={starting}
                    onClick={() => void start()}
                  />
                )}
              </HStack>
            </VStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={6}>
            <VStack gap={8}>
              <Section variant={running ? "section" : "muted"} padding={5} dividers={["bottom"]}>
                <HStack gap={5} hAlign="between" vAlign="center" wrap="wrap">
                  <HStack gap={4} vAlign="center">
                    <Icon
                      icon={running ? BoltIcon : CommandLineIcon}
                      size="lg"
                      color={running ? "success" : "secondary"}
                    />
                    <VStack gap={0.5}>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Heading level={2}>{running ? "Agent 在线" : "Agent 未运行"}</Heading>
                        {info ? (
                          <Badge variant="neutral" label={info.agentKind === "codex" ? "Codex" : "Claude"} />
                        ) : null}
                      </HStack>
                      <StatusDot
                        variant={running ? "success" : "neutral"}
                        label={running ? "渠道连接正常" : "当前没有活动连接"}
                        isPulsing={running}
                      />
                    </VStack>
                  </HStack>
                  <MetadataList orientation="horizontal">
                    <MetadataListItem label="进程">{bots.length}</MetadataListItem>
                    <MetadataListItem label="最长运行">{longestUptime ? uptime(longestUptime) : "—"}</MetadataListItem>
                    <MetadataListItem label="刷新">5 秒</MetadataListItem>
                  </MetadataList>
                </HStack>
              </Section>

              <Section variant="transparent" padding={0}>
                <VStack gap={4}>
                  <HStack gap={3} hAlign="between" vAlign="center">
                    <VStack gap={0.5}>
                      <Heading level={2}>当前连接</Heading>
                      <Text type="supporting" color="secondary">Supervisor 返回的实时进程</Text>
                    </VStack>
                    <StatusDot
                      variant={running ? "success" : "neutral"}
                      label={running ? "连接正常" : "暂无连接"}
                      isPulsing={running}
                    />
                  </HStack>
                  <Divider />
                  {bots.length === 0 ? (
                    <EmptyState
                      title="没有活动连接"
                      description="Agent 启动后，进程版本、PID 和运行时间会显示在这里。"
                      icon={<Icon icon={CommandLineIcon} size="lg" color="secondary" />}
                      actions={!running ? (
                        <Button label="启动 Agent" variant="primary" onClick={() => void start()} />
                      ) : undefined}
                      isCompact
                    />
                  ) : (
                    <Grid columns={{ minWidth: 280, max: 3, repeat: "fit" }} gap={4}>
                      {bots.map((bot) => (
                        <Card key={bot.id} padding={4} elevation="low">
                          <VStack gap={3}>
                            <HStack gap={2} hAlign="between" vAlign="center">
                              <StatusDot variant="success" label={bot.botName ?? "在线"} isPulsing />
                              <Badge variant="neutral" label={`v${bot.version}`} />
                            </HStack>
                            <MetadataList orientation="vertical">
                              <MetadataListItem label="引擎">{bot.agentKind}</MetadataListItem>
                              <MetadataListItem label="进程 PID">{bot.pid}</MetadataListItem>
                              <MetadataListItem label="运行时间">{uptime(bot.uptimeMs)}</MetadataListItem>
                            </MetadataList>
                          </VStack>
                        </Card>
                      ))}
                    </Grid>
                  )}
                </VStack>
              </Section>

              <Section variant="transparent" padding={0}>
                <VStack gap={4}>
                  <VStack gap={0.5}>
                    <Heading level={2}>Agent 设置</Heading>
                    <Text type="supporting" color="secondary">修改模型、回复方式、访问边界和会议能力。</Text>
                  </VStack>
                  <Divider />
                  <ConfigView profile={profile} />
                </VStack>
              </Section>
            </VStack>
          </LayoutContent>
        }
      />

      <AlertDialog
        isOpen={confirm}
        onOpenChange={setConfirm}
        title={`停止 ${profile}？`}
        description="Agent 会断开渠道连接并停止接收新消息，当前控制台仍可继续使用。"
        cancelLabel="继续运行"
        actionLabel="停止 Agent"
        isActionLoading={stopping}
        onAction={() => void confirmStop()}
      />
    </>
  );
}
