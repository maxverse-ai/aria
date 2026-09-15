import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { ToastViewport } from "@astryxdesign/core/Toast";
import {
  CalendarDaysIcon,
  CommandLineIcon,
  CpuChipIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import { apiGet } from "@/lib/api";
import type { OnboardState, Status } from "@/lib/types";
import { ProfilesView } from "@/views/ProfilesView";
import { ProfileDetail } from "@/views/ProfileDetail";
import { OnboardWizard } from "@/views/OnboardWizard";
import { TriggersView } from "@/views/TriggersView";

type ConsoleRoute =
  | { kind: "workspace" }
  | { kind: "automations" }
  | { kind: "profile"; profile: string };

export function App() {
  const [onboard, setOnboard] = useState<OnboardState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [route, setRoute] = useState<ConsoleRoute>({ kind: "workspace" });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const nextOnboard = await apiGet<OnboardState>("/api/onboard/state");
      setOnboard(nextOnboard);
      setStatus(nextOnboard.hasConfig
        ? await apiGet<Status>("/api/status").catch(() => null)
        : null);
      setError(null);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const shell = (children: ReactNode) => (
    <ConsoleShell
      status={status}
      profiles={onboard?.profiles ?? []}
      route={route}
      onRoute={setRoute}
    >
      {children}
    </ConsoleShell>
  );

  if (error) {
    return shell(
      <Layout content={
        <LayoutContent padding={6}>
          <EmptyState
            title="控制台暂时不可用"
            description={error}
            actions={<Button label="重新连接" variant="primary" onClick={() => void refresh()} />}
          />
        </LayoutContent>
      } />,
    );
  }

  if (!onboard) {
    return shell(
      <Layout content={
        <LayoutContent padding={6}>
          <Card variant="muted" padding={8}>
            <HStack gap={3} hAlign="center" vAlign="center">
              <Spinner label="正在连接 Aria" />
              <Text color="secondary">正在读取本机 Supervisor…</Text>
            </HStack>
          </Card>
        </LayoutContent>
      } />,
    );
  }

  if (!onboard.hasConfig) {
    return shell(
      <Layout content={
        <LayoutContent padding={6}>
          <Card variant="blue" padding={8} maxWidth={760}>
            <OnboardWizard onCreated={() => void refresh()} />
          </Card>
        </LayoutContent>
      } />,
    );
  }

  if (route.kind === "automations") {
    return shell(<TriggersView profiles={onboard.profiles} />);
  }

  if (route.kind === "profile") {
    return shell(
      <ProfileDetail
        profile={route.profile}
        onBack={() => {
          setRoute({ kind: "workspace" });
          void refresh();
        }}
      />,
    );
  }

  return shell(
    <ProfilesView
      status={status}
      onOpen={(profile) => setRoute({ kind: "profile", profile })}
      onProfilesChanged={() => void refresh()}
    />,
  );
}

function ConsoleShell({
  children,
  status,
  profiles,
  route,
  onRoute,
}: {
  children: ReactNode;
  status: Status | null;
  profiles: string[];
  route: ConsoleRoute;
  onRoute: (route: ConsoleRoute) => void;
}) {
  return (
    <ToastViewport position="bottomEnd" maxVisible={4}>
      <AppShell
        variant="surface"
        contentPadding={0}
        height="fill"
        mobileNav={{ breakpoint: "md" }}
        sideNav={
          <SideNav
            collapsible
            resizable={{ defaultWidth: 264, minWidth: 224, maxWidth: 360 }}
            header={
              <SideNavHeading
                heading="Aria"
                superheading="Agent workspace"
                headingHref="#workspace"
                icon={<NavIcon icon={<Icon icon={CommandLineIcon} size="sm" color="accent" />} />}
                onClick={(event) => {
                  event.preventDefault();
                  onRoute({ kind: "workspace" });
                }}
              />
            }
            footer={
              <SideNavSection title="Supervisor" isHeaderHidden>
                <SideNavItem
                  label={status ? `${status.online} 个 Agent 在线` : "正在连接"}
                  icon={CpuChipIcon}
                  href="#status"
                  endContent={
                    <StatusDot
                      variant={status ? "success" : "warning"}
                      label={status ? `Supervisor v${status.version}` : "连接中"}
                      isPulsing={Boolean(status)}
                    />
                  }
                  onClick={(event) => event.preventDefault()}
                />
              </SideNavSection>
            }
          >
            <SideNavSection title="导航" isHeaderHidden>
              <SideNavItem
                label="工作台"
                icon={Squares2X2Icon}
                href="#workspace"
                isSelected={route.kind === "workspace"}
                onClick={(event) => {
                  event.preventDefault();
                  onRoute({ kind: "workspace" });
                }}
              />
              <SideNavItem
                label="自动化"
                icon={CalendarDaysIcon}
                href="#automations"
                isSelected={route.kind === "automations"}
                onClick={(event) => {
                  event.preventDefault();
                  onRoute({ kind: "automations" });
                }}
              />
            </SideNavSection>
            {profiles.length > 0 ? (
              <>
                <Divider />
                <SideNavSection title="Agent">
                  <VStack gap={0.5}>
                    {profiles.map((profile) => (
                      <SideNavItem
                        key={profile}
                        label={profile}
                        icon={CommandLineIcon}
                        href={`#profile-${encodeURIComponent(profile)}`}
                        isSelected={route.kind === "profile" && route.profile === profile}
                        onClick={(event) => {
                          event.preventDefault();
                          onRoute({ kind: "profile", profile });
                        }}
                      />
                    ))}
                  </VStack>
                </SideNavSection>
              </>
            ) : null}
          </SideNav>
        }
      >
        {children}
      </AppShell>
    </ToastViewport>
  );
}
