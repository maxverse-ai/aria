import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutPanel,
} from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import {
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  KeyIcon,
  LockClosedIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  UserGroupIcon,
  VideoCameraIcon,
} from "@heroicons/react/24/outline";
import { apiGet, apiPost } from "@/lib/api";
import type {
  ConfigView as ConfigData,
  DeviceLogin,
  KnownChat,
  MeetingConfig,
  MeetingPreflight,
  MeetingsView,
  ModelCatalogView,
  UserAuthStatus,
  UserChat,
} from "@/lib/types";

type SettingsSection = "behavior" | "access" | "meeting";

const SETTINGS_SECTIONS = [
  {
    value: "behavior" as const,
    label: "行为与运行",
    description: "模型、回复与进程策略",
    icon: Cog6ToothIcon,
  },
  {
    value: "access" as const,
    label: "访问边界",
    description: "用户、群与管理员",
    icon: ShieldCheckIcon,
  },
  {
    value: "meeting" as const,
    label: "会议能力",
    description: "权限检查与实时会议",
    icon: VideoCameraIcon,
  },
];

export function ConfigView({ profile }: { profile: string }) {
  const [cfg, setCfg] = useState<ConfigData | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatNames, setChatNames] = useState<Record<string, string>>({});
  const [section, setSection] = useState<SettingsSection>("behavior");
  const isNarrow = useMediaQuery("(max-width: 900px)");
  const showToast = useToast();

  const load = () =>
    apiGet<ConfigData>(`/api/config?profile=${encodeURIComponent(profile)}`)
      .then((config) => {
        setCfg(config);
        setError(null);
        return config;
      })
      .catch((e) => {
        setError(String(e.message ?? e));
        return null;
      });

  const loadChatNames = () =>
    apiGet<{ chats: { id: string; name: string }[] }>(`/api/chats?profile=${encodeURIComponent(profile)}`)
      .then((result) => {
        setChatNames((current) => ({
          ...current,
          ...Object.fromEntries(result.chats.map((chat) => [chat.id, chat.name])),
        }));
      })
      .catch(() => undefined);

  const loadModels = async (force = false) => {
    setModelRefreshing(true);
    try {
      if (force) await apiPost<ModelCatalogView>(`/api/models?profile=${encodeURIComponent(profile)}`, {});
      const deadline = Date.now() + 5_000;
      let snapshot: ModelCatalogView;
      do {
        snapshot = await apiGet<ModelCatalogView>(`/api/models?profile=${encodeURIComponent(profile)}`);
        setCfg((current) => current ? { ...current, models: snapshot.models } : current);
        if (!snapshot.refreshing && !snapshot.stale) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
    } catch (e) {
      if (force) showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setModelRefreshing(false);
    }
  };

  useEffect(() => {
    setCfg(null);
    setChatNames({});
    void load().then(() => loadModels());
    void loadChatNames();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  if (error) {
    return (
      <EmptyState
        title="配置加载失败"
        description={error}
        actions={<Button label="重试" onClick={() => void load()} />}
      />
    );
  }

  if (!cfg) {
    return (
      <Card padding={6}>
        <HStack gap={2} hAlign="center" vAlign="center">
          <Spinner size="sm" aria-label="正在加载配置" />
          <Text color="secondary">正在加载配置…</Text>
        </HStack>
      </Card>
    );
  }

  const update = <K extends keyof ConfigData>(key: K, value: ConfigData[K]) =>
    setCfg({ ...cfg, [key]: value });
  const team = cfg.mode === "team";

  async function save() {
    const current = cfg;
    if (!current) return;
    setSaving(true);
    try {
      const next = await apiPost<ConfigData>(`/api/config?profile=${encodeURIComponent(profile)}`, {
        mode: current.mode,
        meeting: current.meeting,
        model: current.model,
        messageReply: current.messageReply,
        showToolCalls: current.showToolCalls,
        cotMessages: current.cotMessages,
        maxConcurrentRuns: current.maxConcurrentRuns,
        runIdleTimeoutMinutes: current.runIdleTimeoutMinutes,
        requireMentionInGroup: current.requireMentionInGroup,
        larkCliIdentity: current.larkCliIdentity,
      });
      setCfg(next);
      showToast({ body: next.live ? "已保存，立即生效" : "已保存，下次启动该 Profile 生效" });
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function access(action: "add" | "remove", kind: "user" | "admin" | "chat", id: string) {
    if (!id.trim()) return;
    try {
      const next = await apiPost<ConfigData["access"]>(
        `/api/access?profile=${encodeURIComponent(profile)}`,
        { action, kind, id: id.trim() },
      );
      setCfg((current) => current ? { ...current, access: next } : current);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    }
  }

  async function setMention(id: string, requireMention: boolean | null) {
    try {
      const next = await apiPost<ConfigData["access"]>(
        `/api/access?profile=${encodeURIComponent(profile)}`,
        { action: "set-mention", kind: "chat", id, requireMention },
      );
      setCfg((current) => current ? { ...current, access: next } : current);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    }
  }

  const settingsNavigation = (
    <VStack gap={3}>
      <VStack gap={0.5}>
        <Heading level={3}>设置分类</Heading>
        <Text type="supporting" color="secondary">选择一组设置进行编辑</Text>
      </VStack>
      <List density="spacious">
        {SETTINGS_SECTIONS.map((item) => (
          <ListItem
            key={item.value}
            label={item.label}
            description={item.description}
            startContent={<Icon icon={item.icon} size="sm" />}
            isSelected={section === item.value}
            onClick={() => setSection(item.value)}
          />
        ))}
      </List>
    </VStack>
  );

  return (
    <Card padding={0}>
      <Layout
        contentWidth={1200}
        start={isNarrow ? undefined : (
          <LayoutPanel width={260} hasDivider padding={3} label="Agent 设置分类">
            {settingsNavigation}
          </LayoutPanel>
        )}
        content={
          <LayoutContent padding={4}>
            <VStack gap={6}>
              {isNarrow ? (
                <Selector
                  label="设置分类"
                  value={section}
                  options={SETTINGS_SECTIONS.map((item) => ({ value: item.value, label: item.label }))}
                  onChange={(value) => setSection(value as SettingsSection)}
                  width="100%"
                />
              ) : null}

              <VStack gap={0.5}>
                <Heading level={2}>{SETTINGS_SECTIONS.find((item) => item.value === section)?.label}</Heading>
                <Text color="secondary">
                  {SETTINGS_SECTIONS.find((item) => item.value === section)?.description}
                </Text>
              </VStack>

              {section === "behavior" ? (
                <VStack gap={8} id="agent-behavior-panel">
      <SettingsPanel
        title="运行模式"
        description="决定 Profile 的访问模型与身份边界。"
        icon={Cog6ToothIcon}
        badge={<Badge variant={cfg.live ? "success" : "neutral"} label={cfg.live ? "即时生效" : "下次启动生效"} />}
      >
        <Selector
          label="个人版 / 团队版"
          description="团队版允许任何人通过 @ 使用，CLI 强制应用身份；管理命令仍限 owner/管理员。"
          value={cfg.mode}
          options={[
            { value: "personal", label: "个人版（默认）" },
            { value: "team", label: "团队版" },
          ]}
          onChange={(value) => update("mode", value as ConfigData["mode"])}
          width="100%"
        />
      </SettingsPanel>

      <SettingsPanel
        title="回复与运行"
        description="模型、呈现方式与并发控制。"
        icon={ChatBubbleLeftRightIcon}
      >
        <Grid columns={{ minWidth: 280, max: 2, repeat: "fit" }} gap={4}>
          <VStack gap={2}>
            <Selector
              label="模型"
              description="目录在后台刷新，超时会继续使用最近缓存。"
              value={cfg.model}
              options={cfg.models.map((model) => ({ value: model.value, label: model.label }))}
              onChange={(value) => update("model", value)}
              width="100%"
            />
            <Button
              label="刷新模型目录"
              variant="ghost"
              size="sm"
              icon={<Icon icon={ArrowPathIcon} size="sm" />}
              isLoading={modelRefreshing}
              isDisabled={modelRefreshing}
              onClick={() => void loadModels(true)}
            />
          </VStack>
          <Selector
            label="消息回复方式"
            value={cfg.messageReply}
            options={[
              { value: "markdown", label: "消息卡片（默认）" },
              { value: "text", label: "纯文本" },
            ]}
            onChange={(value) => update("messageReply", value as ConfigData["messageReply"])}
            width="100%"
          />
          <Selector
            label="COT 过程消息"
            value={cfg.cotMessages}
            options={[
              { value: "off", label: "关闭" },
              { value: "brief", label: "简略" },
              { value: "detailed", label: "详细" },
            ]}
            onChange={(value) => update("cotMessages", value as ConfigData["cotMessages"])}
            width="100%"
          />
          <NumberInput
            label="并发上限"
            description="允许范围 1–50。"
            value={cfg.maxConcurrentRuns}
            min={1}
            max={50}
            isIntegerOnly
            onChange={(value) => update("maxConcurrentRuns", value)}
            width="100%"
          />
          <NumberInput
            label="探活分钟"
            description="0 表示关闭，最大 120 分钟。"
            value={cfg.runIdleTimeoutMinutes}
            min={0}
            max={120}
            isIntegerOnly
            onChange={(value) => update("runIdleTimeoutMinutes", value)}
            width="100%"
          />
        </Grid>
        <Divider />
        <Switch
          label="显示工具调用"
          description="在回复中显示 bot 执行的命令与文件读写过程。"
          value={cfg.showToolCalls}
          onChange={(value) => update("showToolCalls", value)}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        <Switch
          label="群消息默认需要 @ bot"
          description="单个群可以在访问控制中覆盖此默认值。"
          value={cfg.requireMentionInGroup}
          onChange={(value) => update("requireMentionInGroup", value)}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
      </SettingsPanel>

      <SettingsPanel
        title="lark-cli 身份策略"
        description="控制 bot 能否访问用户个人资源。"
        icon={KeyIcon}
      >
        <Selector
          label="默认身份"
          value={cfg.larkCliIdentity}
          options={[
            { value: "bot-only", label: "只允许应用身份" },
            { value: "user-default", label: "允许用户身份" },
          ]}
          onChange={(value) => update("larkCliIdentity", value as ConfigData["larkCliIdentity"])}
          width="100%"
        />
        <Text type="supporting" color="secondary">
          应用身份不访问个人资源；用户身份可访问已授权用户的日历、邮箱和云盘等。
        </Text>
        {team && (
          <Banner
            status="info"
            title="团队版会覆盖身份策略"
            description="当前固定为只允许应用身份，切回个人版后恢复。"
            collapsible={false}
          />
        )}
      </SettingsPanel>

                </VStack>
              ) : null}

              {section === "meeting" ? (
                <VStack gap={8} id="agent-meeting-panel">
                  <MeetingPanel profile={profile} config={cfg.meeting} onChange={(meeting) => update("meeting", meeting)} />
                </VStack>
              ) : null}

              {section === "access" ? (
                <VStack gap={8} id="agent-access-panel">
      <SettingsPanel
        title="访问控制"
        description="管理可用用户、群与管理员。"
        icon={ShieldCheckIcon}
      >
        {team && (
          <Banner
            status="info"
            title="团队版下白名单不生效"
            description="配置会保留，切回个人版后恢复。"
            collapsible={false}
          />
        )}
        <AccessList
          label="允许私聊的用户"
          placeholder="ou_..."
          ids={cfg.access.allowedUsers}
          onAdd={(id) => void access("add", "user", id)}
          onRemove={(id) => void access("remove", "user", id)}
        />
        <Divider />
        <AllowedChats
          profile={profile}
          ids={cfg.access.allowedChats}
          chatRequireMention={cfg.access.chatRequireMention}
          chatNames={chatNames}
          globalRequire={cfg.requireMentionInGroup}
          onAdd={(id, name) => {
            void access("add", "chat", id);
            if (name) setChatNames((current) => ({ ...current, [id]: name }));
          }}
          onRemove={(id) => void access("remove", "chat", id)}
          onSetMention={(id, mention) => void setMention(id, mention)}
        />
        <Divider />
        <AccessList
          label="管理员"
          placeholder="ou_..."
          ids={cfg.access.admins}
          onAdd={(id) => void access("add", "admin", id)}
          onRemove={(id) => void access("remove", "admin", id)}
        />
      </SettingsPanel>
                </VStack>
              ) : null}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider padding={3}>
            <HStack gap={2} hAlign="end" vAlign="center">
              <Button label="重新加载" variant="ghost" isDisabled={saving} onClick={() => void load()} />
              <Button
                label="保存配置"
                variant="primary"
                isLoading={saving}
                isDisabled={saving}
                onClick={() => void save()}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Card>
  );
}

function SettingsPanel({
  title,
  description,
  icon,
  badge,
  headerAction,
  children,
}: {
  title: string;
  description?: string;
  icon: typeof Cog6ToothIcon;
  badge?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Section variant="transparent" padding={0} dividers={["bottom"]}>
      <VStack gap={4} paddingBlockEnd={6}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <HStack gap={3} vAlign="center">
            <Icon icon={icon} color="secondary" />
            <VStack gap={0.5}>
              <Heading level={3}>{title}</Heading>
              {description && <Text type="supporting" color="secondary">{description}</Text>}
            </VStack>
          </HStack>
          {headerAction ?? badge}
        </HStack>
        <Divider />
        <VStack gap={4}>{children}</VStack>
      </VStack>
    </Section>
  );
}

function MeetingPreflightPanel({
  preflight,
  checking,
  onRecheck,
}: {
  preflight: MeetingPreflight | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (!preflight) {
    return (
      <HStack gap={2} vAlign="center">
        {checking && <Spinner size="sm" aria-label="检查会议权限" />}
        <Text type="supporting" color="secondary">{checking ? "检查权限中…" : "尚未检查"}</Text>
      </HStack>
    );
  }

  if (preflight.status === "ok") {
    return (
      <Banner
        status="success"
        title="应用权限已就绪"
        description="会议智能体所需的应用权限检查通过。"
        icon={<Icon icon={CheckCircleIcon} size="md" />}
        endContent={
          <Button label="重新检查" variant="ghost" size="sm" isLoading={checking} onClick={onRecheck} />
        }
        collapsible={false}
      />
    );
  }

  const scopeMissing = preflight.status === "scope-missing";
  return (
    <Banner
      status={scopeMissing ? "error" : "warning"}
      title={scopeMissing ? "缺少应用权限" : preflight.status === "not-in-beta" ? "内测未开通" : "权限状态未知"}
      description={preflight.message}
      endContent={<Button label="重新检查" variant="ghost" size="sm" isLoading={checking} onClick={onRecheck} />}
      collapsible={false}
    >
      <VStack gap={4}>
        {scopeMissing && (
          <List density="compact" hasDividers>
            {preflight.requiredScopes.map((scope) => (
              <ListItem
                key={scope.scope}
                label={<Text type="code">{scope.scope}</Text>}
                description={`${scope.purpose}${preflight.missingScopes.includes(scope.scope) ? "（已确认缺失）" : ""}`}
                startContent={
                  <StatusDot
                    variant={preflight.missingScopes.includes(scope.scope) ? "error" : "neutral"}
                    label={preflight.missingScopes.includes(scope.scope) ? "缺失" : "待确认"}
                  />
                }
              />
            ))}
          </List>
        )}
        {(preflight.consoleUrl || preflight.betaChatUrl) && (
          <HStack gap={4} vAlign="start" wrap="wrap">
            <VStack gap={2}>
              {preflight.consoleUrl && (
                <Button label="去开通权限" variant="primary" href={preflight.consoleUrl} target="_blank" rel="noreferrer" />
              )}
              {preflight.betaChatUrl && (
                <Button label="加入内测群申请" href={preflight.betaChatUrl} target="_blank" rel="noreferrer" />
              )}
              <Text type="supporting" color="secondary">完成后重新检查；权限变更后需重启 Profile。</Text>
            </VStack>
            <Card padding={2} style={{ background: "white" }}>
              <QRCodeSVG value={preflight.consoleUrl ?? preflight.betaChatUrl!} size={104} />
            </Card>
          </HStack>
        )}
        <VStack gap={2}>
          <Text weight="semibold">还需以长连接模式订阅事件</Text>
          <List density="compact">
            {preflight.requiredEvents.map((event) => (
              <ListItem key={event} label={<Text type="code">{event}</Text>} />
            ))}
          </List>
          <Text type="supporting" color="secondary">未订阅时会自动降级为轮询，字幕会慢几秒。</Text>
        </VStack>
      </VStack>
    </Banner>
  );
}

function MeetingPanel({
  profile,
  config,
  onChange,
}: {
  profile: string;
  config: MeetingConfig;
  onChange: (next: MeetingConfig) => void;
}) {
  const [live, setLive] = useState<MeetingsView | null>(null);
  const [preflightState, setPreflightState] = useState<MeetingPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [meetingNo, setMeetingNo] = useState("");
  const [busy, setBusy] = useState(false);
  const showToast = useToast();

  const update = <K extends keyof MeetingConfig>(key: K, value: MeetingConfig[K]) =>
    onChange({ ...config, [key]: value });

  const load = () =>
    apiGet<MeetingsView>(`/api/meetings?profile=${encodeURIComponent(profile)}`)
      .then(setLive)
      .catch(() => setLive(null));

  async function checkPreflight() {
    setChecking(true);
    try {
      setPreflightState(
        await apiGet<MeetingPreflight>(`/api/meetings/preflight?profile=${encodeURIComponent(profile)}`),
      );
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (!config.enabled) return;
    void load();
    void checkPreflight();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, config.enabled]);

  async function join() {
    const normalized = meetingNo.replace(/\s/g, "");
    if (!/^\d{9}$/.test(normalized)) {
      showToast({ body: "会议号必须是 9 位数字", type: "error" });
      return;
    }
    setBusy(true);
    try {
      await apiPost("/api/meetings/join", { profile, meetingNo: normalized });
      setMeetingNo("");
      showToast({ body: "已入会" });
      await load();
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function leave(meetingId: string) {
    setBusy(true);
    try {
      await apiPost("/api/meetings/leave", { profile, meetingId });
      showToast({ body: "已离会" });
      await load();
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPanel
      title="会议智能体"
      description="作为参会人读取字幕与会中消息并作答。"
      icon={VideoCameraIcon}
      headerAction={
        <Switch
          label="启用会议智能体"
          isLabelHidden
          value={config.enabled}
          onChange={(value) => update("enabled", value)}
        />
      }
    >
      <Banner
        status="info"
        title="需要会议 Bot 内测与应用权限"
        description="开关变更后需重启 Profile 生效。"
        collapsible={false}
      />
      {config.enabled && (
        <>
          <MeetingPreflightPanel preflight={preflightState} checking={checking} onRecheck={() => void checkPreflight()} />
          <Grid columns={{ minWidth: 260, max: 2, repeat: "fit" }} gap={4}>
            <Selector
              label="回答发到哪"
              value={config.respondIn}
              options={[
                { value: "meeting", label: "会中消息" },
                { value: "im", label: "IM 私聊" },
                { value: "both", label: "两者" },
              ]}
              onChange={(value) => update("respondIn", value as MeetingConfig["respondIn"])}
              width="100%"
            />
            <TextInput
              label="会中触发前缀"
              description="@ bot 当前名称始终有效。"
              value={config.trigger}
              onChange={(value) => update("trigger", value)}
              width="100%"
            />
            <NumberInput
              label="字幕上下文条数"
              value={config.transcript.keep}
              min={10}
              max={2_000}
              isIntegerOnly
              onChange={(value) => update("transcript", { ...config.transcript, keep: value })}
              width="100%"
            />
            <NumberInput
              label="字幕定稿防抖"
              description="0 表示关闭。"
              value={config.transcript.stabilizeMs}
              min={0}
              max={30_000}
              units="ms"
              isIntegerOnly
              onChange={(value) => update("transcript", { ...config.transcript, stabilizeMs: value })}
              width="100%"
            />
          </Grid>
          <Switch
            label="被邀请时自动入会"
            description="依赖 vc.bot.meeting_invited_v1 长连接推送。"
            value={config.autoJoinOnInvite}
            onChange={(value) => update("autoJoinOnInvite", value)}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
          <Switch
            label="会议结束自动生成纪要"
            value={config.summaryOnEnd}
            onChange={(value) => update("summaryOnEnd", value)}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
          />
          {config.summaryOnEnd && (
            <Selector
              label="纪要发送目标"
              value={config.summaryTarget}
              options={[
                { value: "origin", label: "入会来源的聊天" },
                { value: "owner", label: "Bot owner 私聊" },
              ]}
              onChange={(value) => update("summaryTarget", value as MeetingConfig["summaryTarget"])}
              width="100%"
            />
          )}
          <Divider />
          {!live?.available ? (
            <Banner
              status="warning"
              title="实时会议状态不可用"
              description={live?.reason ?? "正在加载运行状态…"}
              collapsible={false}
            />
          ) : (
            <VStack gap={3}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Heading level={4}>在会会议（{live.sessions.length}）</Heading>
                <Badge
                  variant={live.push.hooked ? (live.push.received > 0 ? "success" : "neutral") : "error"}
                  label={live.push.hooked
                    ? live.push.received > 0
                      ? `推送正常 · ${live.push.received} 条`
                      : "推送已挂载 · 未收到"
                    : "推送未挂载"}
                />
              </HStack>
              {live.push.hooked && live.push.received === 0 && (
                <Text type="supporting" color="secondary">尚未收到 vc.bot.* 推送，期间会用轮询兜底。</Text>
              )}
              {!live.push.hooked && live.push.reason && (
                <Banner status="error" title="推送未挂载" description={live.push.reason} collapsible={false} />
              )}
              {live.sessions.length === 0 ? (
                <EmptyState title="暂无在会会议" description="输入 9 位会议号即可手动入会。" isCompact />
              ) : (
                <List density="spacious" hasDividers>
                  {live.sessions.map((session) => (
                    <ListItem
                      key={session.meetingId}
                      label={session.topic ?? session.meetingNo}
                      description={`${session.meetingNo} · ${session.source === "push" ? "推送" : "轮询"} · 字幕 ${session.transcriptLines} 条 · 参会 ${session.participants} 人 · 事件 ${Object.entries(session.eventCounts).map(([key, value]) => `${key}×${value}`).join(" / ") || "无"}`}
                      startContent={<StatusDot variant="success" label="在会" isPulsing />}
                      endContent={<Button label="离会" variant="ghost" size="sm" isDisabled={busy} onClick={() => void leave(session.meetingId)} />}
                    />
                  ))}
                </List>
              )}
              <HStack gap={2} vAlign="end" wrap="wrap">
                <TextInput
                  label="手动入会"
                  isLabelHidden
                  placeholder="9 位会议号"
                  value={meetingNo}
                  onChange={setMeetingNo}
                  onEnter={() => void join()}
                  width="100%"
                />
                <Button label="入会" variant="secondary" isLoading={busy} isDisabled={busy} onClick={() => void join()} />
              </HStack>
            </VStack>
          )}
        </>
      )}
    </SettingsPanel>
  );
}

function AllowedChats({
  profile,
  ids,
  chatRequireMention,
  chatNames,
  globalRequire,
  onAdd,
  onRemove,
  onSetMention,
}: {
  profile: string;
  ids: string[];
  chatRequireMention: Record<string, boolean>;
  chatNames: Record<string, string>;
  globalRequire: boolean;
  onAdd: (id: string, name?: string) => void;
  onRemove: (id: string) => void;
  onSetMention: (id: string, requireMention: boolean | null) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <VStack gap={3}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={0.5}>
          <Heading level={4}>允许响应的群</Heading>
          <Text type="supporting" color="secondary">每个群可覆盖全局 @ 策略。</Text>
        </VStack>
        <Badge variant="neutral" label={ids.length} />
      </HStack>
      {ids.length === 0 ? (
        <EmptyState title="没有允许的群" description="从群选择器或手动输入 chat_id。" isCompact />
      ) : (
        <List density="spacious" hasDividers>
          {ids.map((id) => {
            const override = chatRequireMention[id];
            const value = override === undefined ? "global" : override ? "on" : "off";
            return (
              <ListItem
                key={id}
                label={chatNames[id] ?? id}
                description={chatNames[id] ? id : undefined}
                startContent={<Icon icon={UserGroupIcon} size="sm" color="secondary" />}
                endContent={
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Selector
                      label={`@ 策略：${chatNames[id] ?? id}`}
                      isLabelHidden
                      value={value}
                      options={[
                        { value: "global", label: `跟随全局（${globalRequire ? "需 @" : "无需 @"}）` },
                        { value: "on", label: "需要 @" },
                        { value: "off", label: "无需 @" },
                      ]}
                      onChange={(next) => onSetMention(id, next === "global" ? null : next === "on")}
                      width={170}
                    />
                    <Button label="移除" variant="ghost" size="sm" onClick={() => onRemove(id)} />
                  </HStack>
                }
              />
            );
          })}
        </List>
      )}
      <Grid columns={{ minWidth: 240, max: 2, repeat: "fit" }} gap={2}>
        <Button
          label="选择群"
          variant="secondary"
          icon={<Icon icon={PlusIcon} size="sm" />}
          width="100%"
          onClick={() => setPickerOpen(true)}
        />
        <HStack gap={2} vAlign="end">
          <TextInput
            label="手动输入群 chat_id"
            isLabelHidden
            placeholder="oc_..."
            value={draft}
            onChange={setDraft}
            onEnter={() => {
              onAdd(draft);
              setDraft("");
            }}
            width="100%"
          />
          <Button
            label="添加"
            variant="ghost"
            isDisabled={!draft.trim()}
            onClick={() => {
              onAdd(draft);
              setDraft("");
            }}
          />
        </HStack>
      </Grid>
      <GroupPicker
        profile={profile}
        isOpen={pickerOpen}
        onOpenChange={setPickerOpen}
        added={ids}
        onPick={onAdd}
      />
    </VStack>
  );
}

function GroupPicker({
  profile,
  isOpen,
  onOpenChange,
  added,
  onPick,
}: {
  profile: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  added: string[];
  onPick: (id: string, name?: string) => void;
}) {
  const [tab, setTab] = useState("bot");
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width={720} purpose="form">
      <Layout
        header={<DialogHeader title="选择群" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent padding={4}>
            <VStack gap={4}>
              <Text color="secondary">从 bot 已加入的群选择，或通过你的飞书身份浏览“我的群”。</Text>
              <TabList value={tab} onChange={setTab} layout="fill" role="tablist" hasDivider>
                <Tab value="bot" label="Bot 所在的群" panelId="bot-chat-panel" />
                <Tab value="mine" label="我的群" panelId="my-chat-panel" />
              </TabList>
              <div id={tab === "bot" ? "bot-chat-panel" : "my-chat-panel"} role="tabpanel">
                {tab === "bot" ? (
                  <BotChatsPane profile={profile} isOpen={isOpen} added={added} onPick={onPick} />
                ) : (
                  <MyChatsPane profile={profile} isOpen={isOpen} added={added} onPick={onPick} />
                )}
              </div>
            </VStack>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}

function BotChatsPane({
  profile,
  isOpen,
  added,
  onPick,
}: {
  profile: string;
  isOpen: boolean;
  added: string[];
  onPick: (id: string, name?: string) => void;
}) {
  const [chats, setChats] = useState<KnownChat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showToast = useToast();

  useEffect(() => {
    if (!isOpen) return;
    setChats(null);
    setError(null);
    void apiGet<{ chats: KnownChat[] }>(`/api/chats?profile=${encodeURIComponent(profile)}`)
      .then((result) => setChats(result.chats))
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, [isOpen, profile]);

  const addedSet = new Set(added);
  if (error) return <Banner status="error" title="群列表加载失败" description={error} collapsible={false} />;
  if (chats === null) return <Spinner size="sm" label="正在读取 Bot 所在群…" />;
  if (chats.length === 0) {
    return <EmptyState title="没有找到群" description="确认 Profile 在线且 bot 已被加入群聊。" isCompact />;
  }

  return (
    <List density="spacious" hasDividers style={{ maxHeight: "46dvh", overflowY: "auto" }}>
      {chats.map((chat) => (
        <ListItem
          key={chat.id}
          label={chat.name}
          description={chat.id}
          startContent={<Icon icon={UserGroupIcon} size="sm" color="secondary" />}
          endContent={addedSet.has(chat.id)
            ? <Badge variant="success" label="已添加" />
            : (
              <Button
                label="添加"
                variant="secondary"
                size="sm"
                onClick={() => {
                  onPick(chat.id, chat.name);
                  showToast({ body: "添加成功" });
                }}
              />
            )}
        />
      ))}
    </List>
  );
}

const LIST_SCOPES = ["im:chat:read"];
const ADD_BOT_SCOPES = ["im:chat:read", "im:chat.members:write_only"];

function MyChatsPane({
  profile,
  isOpen,
  added,
  onPick,
}: {
  profile: string;
  isOpen: boolean;
  added: string[];
  onPick: (id: string, name?: string) => void;
}) {
  const [status, setStatus] = useState<UserAuthStatus | null>(null);
  const [chats, setChats] = useState<UserChat[] | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<DeviceLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingPull, setPendingPull] = useState<string | null>(null);
  const showToast = useToast();
  const addedSet = new Set(added);
  const canList = Boolean(status?.loggedIn && status.scopes.includes("im:chat:read"));

  const loadStatus = () =>
    apiGet<UserAuthStatus>(`/api/auth/status?profile=${encodeURIComponent(profile)}`)
      .then((next) => {
        setStatus(next);
        return next;
      })
      .catch((e) => {
        setError(String((e as Error).message ?? e));
        return null;
      });

  async function fetchChats(reset: boolean) {
    setListing(true);
    setError(null);
    if (reset) setChats(null);
    try {
      const params = new URLSearchParams({ profile });
      if (query.trim()) params.set("query", query.trim());
      if (!reset && nextToken) params.set("pageToken", nextToken);
      const result = await apiGet<{ chats: UserChat[]; nextPageToken?: string }>(`/api/user-chats?${params}`);
      setChats((current) => reset || !current ? result.chats : [...current, ...result.chats]);
      setNextToken(result.nextPageToken);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setListing(false);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    setChats(null);
    setNextToken(undefined);
    setQuery("");
    setLogin(null);
    setError(null);
    setStatus(null);
    setPendingPull(null);
    void loadStatus().then((next) => {
      if (next?.loggedIn && next.scopes.includes("im:chat:read")) void fetchChats(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, profile]);

  async function startAuth(scopes: string[]) {
    setBusy(true);
    setError(null);
    try {
      setLogin(await apiPost<DeviceLogin>("/api/auth/login/start", { profile, scopes }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function completeAuth() {
    if (!login) return;
    setBusy(true);
    try {
      await apiPost("/api/auth/login/complete", { profile, deviceCode: login.deviceCode });
      setLogin(null);
      showToast({ body: "授权成功" });
      const next = await loadStatus();
      const pull = pendingPull;
      setPendingPull(null);
      if (pull) await pullBot(pull);
      else if (next?.loggedIn && next.scopes.includes("im:chat:read")) await fetchChats(true);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function pullBot(id: string) {
    setBusy(true);
    try {
      const result = await apiPost<{ ok: boolean; pending?: boolean; needAuth?: boolean; message?: string }>(
        "/api/chats/add-bot",
        { profile, chatId: id },
      );
      if (result.needAuth) {
        setPendingPull(id);
        showToast({ body: "拉 bot 进群需要额外授权" });
        await startAuth(ADD_BOT_SCOPES);
        return;
      }
      if (!result.ok) {
        showToast({ body: result.message ?? "把 bot 拉进群失败", type: "error" });
        return;
      }
      if (result.pending) showToast({ body: "已申请，等待群主或管理员通过" });
      else {
        onPick(id, chats?.find((chat) => chat.id === id)?.name);
        showToast({ body: "已把 bot 拉进群，并加入允许列表" });
      }
      setChats((current) => current?.map((chat) => chat.id === id ? { ...chat, botInIt: true } : chat) ?? current);
    } catch (e) {
      showToast({ body: String((e as Error).message ?? e), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (login) {
    return (
      <VStack gap={4} hAlign="center">
        <Text color="secondary">
          {pendingPull ? "需要授权添加群成员权限。" : "需要授权查看群权限。"}
        </Text>
        <Card padding={3} style={{ background: "white" }}>
          <QRCodeSVG value={login.verificationUrl} size={168} />
        </Card>
        <Link href={login.verificationUrl} isExternalLink>在浏览器打开授权</Link>
        {login.userCode && <Badge variant="neutral" label={`验证码：${login.userCode}`} />}
        <HStack gap={2} wrap="wrap" hAlign="center">
          <Button label="我已完成授权" variant="primary" isLoading={busy} onClick={() => void completeAuth()} />
          <Button
            label="取消"
            variant="ghost"
            isDisabled={busy}
            onClick={() => {
              setLogin(null);
              setPendingPull(null);
            }}
          />
        </HStack>
      </VStack>
    );
  }

  if (status && !canList) {
    return (
      <EmptyState
        title="需要飞书用户授权"
        description="浏览“我的群”只申请查看群权限。"
        actions={<Button label="去授权" variant="primary" isLoading={busy} onClick={() => void startAuth(LIST_SCOPES)} />}
        isCompact
      />
    );
  }

  return (
    <VStack gap={3}>
      {status?.userName && <Badge variant="success" label={`已授权：${status.userName}`} />}
      <HStack gap={2} vAlign="end">
        <TextInput
          label="搜索我的群"
          isLabelHidden
          placeholder="按群名搜索…"
          value={query}
          onChange={setQuery}
          onEnter={() => void fetchChats(true)}
          width="100%"
        />
        <Button label="搜索" variant="secondary" isLoading={listing} onClick={() => void fetchChats(true)} />
      </HStack>
      {error && <Banner status="error" title="群列表加载失败" description={error} collapsible={false} />}
      {!error && chats === null && listing && <Spinner size="sm" label="正在加载…" />}
      {chats?.length === 0 && (
        <EmptyState title={query.trim() ? "没有匹配的群" : "没有找到你所在的群"} isCompact />
      )}
      {chats && chats.length > 0 && (
        <List density="spacious" hasDividers style={{ maxHeight: "46dvh", overflowY: "auto" }}>
          {chats.map((chat) => (
            <ListItem
              key={chat.id}
              label={chat.name}
              description={chat.id}
              startContent={<Icon icon={UserGroupIcon} size="sm" color="secondary" />}
              endContent={
                <HStack gap={2} vAlign="center" wrap="wrap">
                  {!chat.botInIt && (
                    <Button label="拉 bot 进群" variant="ghost" size="sm" isDisabled={busy} onClick={() => void pullBot(chat.id)} />
                  )}
                  {addedSet.has(chat.id) ? (
                    <Badge variant="success" label="已添加" />
                  ) : (
                    <Button
                      label="添加"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        onPick(chat.id, chat.name);
                        showToast({ body: "添加成功" });
                      }}
                    />
                  )}
                </HStack>
              }
            />
          ))}
        </List>
      )}
      {nextToken && (
        <Button
          label="加载更多"
          variant="ghost"
          width="100%"
          isLoading={listing}
          onClick={() => void fetchChats(false)}
        />
      )}
      <Text type="supporting" color="secondary">
        Bot 不在的群需要先拉入群；“添加”只会将群加入允许列表。
      </Text>
    </VStack>
  );
}

function AccessList({
  label,
  placeholder,
  ids,
  onAdd,
  onRemove,
}: {
  label: string;
  placeholder: string;
  ids: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <VStack gap={3}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={4}>{label}</Heading>
        <Badge variant="neutral" label={ids.length} />
      </HStack>
      {ids.length === 0 ? (
        <EmptyState title="暂无条目" isCompact />
      ) : (
        <List density="compact" hasDividers>
          {ids.map((id) => (
            <ListItem
              key={id}
              label={<Text type="code">{id}</Text>}
              startContent={<Icon icon={LockClosedIcon} size="sm" color="secondary" />}
              endContent={
                <Button
                  label="移除"
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={TrashIcon} size="sm" />}
                  onClick={() => onRemove(id)}
                />
              }
            />
          ))}
        </List>
      )}
      <HStack gap={2} vAlign="end">
        <TextInput
          label={`添加${label}`}
          isLabelHidden
          placeholder={placeholder}
          value={draft}
          onChange={setDraft}
          onEnter={() => {
            onAdd(draft);
            setDraft("");
          }}
          width="100%"
        />
        <Button
          label="添加"
          variant="secondary"
          isDisabled={!draft.trim()}
          onClick={() => {
            onAdd(draft);
            setDraft("");
          }}
        />
      </HStack>
    </VStack>
  );
}
