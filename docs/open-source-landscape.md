# Allianz Open Source Landscape

This document provides an overview of open source activity across the Allianz Group on GitHub.
Activity is currently spread across multiple organizations reflecting the group's history of acquisitions and independent engineering teams.
There is an ongoing effort to consolidate all open source work under the central [github.com/allianz](https://github.com/allianz) organization.

> Last updated: April 2026

---

## Summary

| Organization | Repos | Active | Archived | Stars | Forks |
|---|---|---|---|---|---|
| [allianz](https://github.com/allianz) | 9 | 4 | 5 | 251 | 48 |
| [AllianzTechnology](https://github.com/AllianzTechnology) | 1 | 1 | 0 | 0 | 1 |
| [allianz-de](https://github.com/allianz-de) | 5 | 5 | 0 | 5 | 4 |
| [allianz-direct](https://github.com/allianz-direct) | 11 | 10 | 1 | 13 | 2 |
| [azukds](https://github.com/azukds) | 8 | 8 | 0 | 119 | 30 |
| [KaiserXLabs](https://github.com/KaiserXLabs) | 12 | 11 | 1 | 8 | 0 |
| [simplesurance](https://github.com/simplesurance) | 24 | 20 | 4 | 467 | 65 |
| **Total** | **70** | **59** | **11** | **863** | **150** |

---

## Notable Projects

The following projects have gained the most traction in the community:

| Project | Organization | Description | Stars | Forks |
|---|---|---|---|---|
| [baur](https://github.com/simplesurance/baur) | simplesurance | Incremental task runner for monorepos | 379 | 14 |
| [ng-aquila](https://github.com/allianz/ng-aquila) | allianz | Angular UI component library for the Open Insurance Platform | 247 | 44 |
| [tubular](https://github.com/azukds/tubular) | azukds | ML feature engineering and pre-processing for pandas/polars | 100 | 27 |
| [jenkins-exporter](https://github.com/simplesurance/jenkins-exporter) | simplesurance | Export Jenkins build metrics to Prometheus | 13 | 14 |
| [grpcconsulresolver](https://github.com/simplesurance/grpcconsulresolver) | simplesurance | Consul resolver for the gRPC-Go library | 12 | 7 |
| [tekton-s3-log-reader](https://github.com/allianz-direct/tekton-s3-log-reader) | allianz-direct | Long-term log reader for Tekton Dashboard backed by S3 | 9 | 1 |
| [model_interpreter](https://github.com/azukds/model_interpreter) | azukds | Machine learning model interpretation toolkit | 9 | 1 |
| [terraform-provider-bunny](https://github.com/simplesurance/terraform-provider-bunny) | simplesurance | Terraform provider for bunny.net CDN *(archived)* | 15 | 8 |

---

## Organizations

### [allianz](https://github.com/allianz) — Core OSPO org

The primary organization managed by the Allianz Open Source Program Office. Target home for all consolidated open source projects.

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [ng-aquila](https://github.com/allianz/ng-aquila) | TypeScript | Angular UI component library for the Open Insurance Platform | 247 | 44 | Active |
| [ospo](https://github.com/allianz/ospo) | JavaScript | Developer guides and automation for the Allianz GitHub org | 0 | 2 | Active |
| [.github](https://github.com/allianz/.github) | — | Default community health files for the Allianz org | 1 | 1 | Active |
| [merge-bot-config](https://github.com/allianz/merge-bot-config) | Groovy | Template configuration for merge-bot | 0 | 0 | Active |
| [license-scout](https://github.com/allianz/license-scout) | Java | Maven plugin to scan used licenses | 2 | 0 | Archived |
| [merge-processor](https://github.com/allianz/merge-processor) | Java | Automates branch merging from SVN | 1 | 0 | Archived |
| [merge-bot](https://github.com/allianz/merge-bot) | Java | Automated branch merging with status checks | 0 | 0 | Archived |
| [calculus-prime-pnc](https://github.com/allianz/calculus-prime-pnc) | — | Insurance tariff rating engine | 0 | 0 | Archived |
| [gem-config](https://github.com/allianz/gem-config) | — | GEM configuration example | 0 | 1 | Archived |

---

### [AllianzTechnology](https://github.com/AllianzTechnology) — IT services

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [terraform-provider-azurerm](https://github.com/AllianzTechnology/terraform-provider-azurerm) | Go | Terraform provider for Azure Resource Manager | 0 | 1 | Active |

---

### [allianz-de](https://github.com/allianz-de) — Allianz Germany

A legacy organization containing CI/CD demo projects from 2018. No active development.

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [cidemo-pipeline-library](https://github.com/allianz-de/cidemo-pipeline-library) | Groovy | Shared Jenkins pipeline library demo | 3 | 1 | Active |
| [cidemo-angular](https://github.com/allianz-de/cidemo-angular) | TypeScript | Angular CI demo | 1 | 0 | Active |
| [cidemo](https://github.com/allianz-de/cidemo) | Groovy | CI demo root project | 1 | 1 | Active |
| [cidemo-jenkins](https://github.com/allianz-de/cidemo-jenkins) | Groovy | Custom Jenkins Docker image demo | 0 | 1 | Active |
| [cidemo-middleware](https://github.com/allianz-de/cidemo-middleware) | JavaScript | Middleware CI demo | 0 | 1 | Active |

---

### [allianz-direct](https://github.com/allianz-direct) — Allianz Direct

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [tekton-s3-log-reader](https://github.com/allianz-direct/tekton-s3-log-reader) | Go | Long-term S3 log reader for Tekton Dashboard | 9 | 1 | Active |
| [saml-auth-proxy](https://github.com/allianz-direct/saml-auth-proxy) | Go | SAML SP authentication proxy for backend services | 0 | 0 | Active |
| [atlantis-helm-charts](https://github.com/allianz-direct/atlantis-helm-charts) | — | Atlantis Helm chart | 0 | 0 | Active |
| [spring-data-dynamodb](https://github.com/allianz-direct/spring-data-dynamodb) | — | Spring Data module for AWS DynamoDB | 0 | 1 | Active |
| [terraform-github-repository](https://github.com/allianz-direct/terraform-github-repository) | — | Terraform module to manage GitHub repositories | 0 | 0 | Active |
| [aws-efs-csi-driver](https://github.com/allianz-direct/aws-efs-csi-driver) | — | CSI Driver for Amazon EFS | 0 | 0 | Active |
| [atlantis-org-applyer](https://github.com/allianz-direct/atlantis-org-applyer) | — | Atlantis apply permissions helper | 0 | 0 | Active |
| [mlflow](https://github.com/allianz-direct/mlflow) | Python | MLflow fork | 0 | 0 | Active |
| [bitnami-charts](https://github.com/allianz-direct/bitnami-charts) | Smarty | Bitnami Helm charts fork | 0 | 0 | Active |
| [bitnami-containers](https://github.com/allianz-direct/bitnami-containers) | — | Bitnami container images fork | 0 | 0 | Active |
| [nb_prep](https://github.com/allianz-direct/nb_prep) | Python | Prepare Jupyter notebooks for git storage and HTML sharing | 4 | 0 | Archived |

---

### [azukds](https://github.com/azukds) — Allianz UK Data Science

Focused on Python tooling for data science and machine learning workflows.

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [tubular](https://github.com/azukds/tubular) | Python | ML feature engineering and pre-processing for pandas/polars | 100 | 27 | Active |
| [model_interpreter](https://github.com/azukds/model_interpreter) | Python | Machine learning model interpretation | 9 | 1 | Active |
| [input_checker](https://github.com/azukds/input_checker) | Python | Validates pandas DataFrames against defined conditions | 5 | 0 | Active |
| [test-aide](https://github.com/azukds/test-aide) | Python | Unit testing helpers for data science projects | 4 | 0 | Active |
| [bodacious](https://github.com/azukds/bodacious) | Python | Tabular feature engineering based on polars expressions | 1 | 0 | Active |
| [Spark-CodeSpace-Test](https://github.com/azukds/Spark-CodeSpace-Test) | Jupyter Notebook | Spark with GitHub Codespaces demo | 0 | 1 | Active |
| [PokeMLops](https://github.com/azukds/PokeMLops) | Python | Pokémon legendary status prediction demo | 0 | 0 | Active |
| [test_repo](https://github.com/azukds/test_repo) | Jupyter Notebook | Codespaces and environment setup practice | 0 | 1 | Active |

---

### [KaiserXLabs](https://github.com/KaiserXLabs) — KaiserX Labs

Innovation lab organization. Contains a mix of original tooling and archived upstream forks from 2018.

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [github-action-workflows](https://github.com/KaiserXLabs/github-action-workflows) | Smarty | Reusable GitHub Actions workflows for Kubernetes artifacts | 2 | 0 | Active |
| [angular-auth0-aside](https://github.com/KaiserXLabs/angular-auth0-aside) | TypeScript | Angular with Auth0 and authenticated Node API | 2 | 0 | Active |
| [bootstrap-material-design](https://github.com/KaiserXLabs/bootstrap-material-design) | JavaScript | Material Design UI kit for Bootstrap 4 | 2 | 0 | Active |
| [web-components-seo](https://github.com/KaiserXLabs/web-components-seo) | JavaScript | Tests SEO indexability of web components | 1 | 0 | Active |
| [ContentEdit](https://github.com/KaiserXLabs/ContentEdit) | JavaScript | JS library for content-editable HTML elements | 1 | 0 | Active |
| [inno-docs](https://github.com/KaiserXLabs/inno-docs) | — | UI wrapper for technical platform documentation | 0 | 0 | Active |
| [cp-helm-charts](https://github.com/KaiserXLabs/cp-helm-charts) | Mustache | Confluent Platform Helm charts | 0 | 0 | Active |
| [grapesjs](https://github.com/KaiserXLabs/grapesjs) | JavaScript | Web builder framework fork | 0 | 0 | Active |
| [foundation-emails](https://github.com/KaiserXLabs/foundation-emails) | HTML | Responsive HTML email framework fork | 0 | 0 | Active |
| [patternlab-edition-node-webpack](https://github.com/KaiserXLabs/patternlab-edition-node-webpack) | JavaScript | Pattern Lab webpack edition | 0 | 0 | Active |
| [nursery-notebook](https://github.com/KaiserXLabs/nursery-notebook) | Jupyter Notebook | Experimental notebook | 0 | 0 | Active |
| [ndbx-docs](https://github.com/KaiserXLabs/ndbx-docs) | HTML | NDBX family documentation templates | 0 | 0 | Archived |

---

### [simplesurance](https://github.com/simplesurance) — simplesurance (acquired)

simplesurance is a Berlin-based insurtech company acquired by Allianz. The organization is the most active contributor in terms of original open source tooling, with a strong focus on Go infrastructure tooling.

| Repository | Language | Description | Stars | Forks | Status |
|---|---|---|---|---|---|
| [baur](https://github.com/simplesurance/baur) | Go | Incremental task runner for monorepos | 379 | 14 | Active |
| [jenkins-exporter](https://github.com/simplesurance/jenkins-exporter) | Go | Export Jenkins build metrics to Prometheus | 13 | 14 | Active |
| [grpcconsulresolver](https://github.com/simplesurance/grpcconsulresolver) | Go | Consul resolver for gRPC-Go | 12 | 7 | Active |
| [proteus](https://github.com/simplesurance/proteus) | Go | Struct-based application configuration loader | 7 | 0 | Active |
| [baur-example](https://github.com/simplesurance/baur-example) | Shell | Example monorepo using baur | 6 | 4 | Active |
| [goordinator](https://github.com/simplesurance/goordinator) | Go | GitHub webhook event processor with JQ filtering | 5 | 1 | Active |
| [registrator](https://github.com/simplesurance/registrator) | Go | Docker service registry bridge | 5 | 2 | Active |
| [go-ip-anonymizer](https://github.com/simplesurance/go-ip-anonymizer) | Go | GDPR-compliant IP address anonymization | 4 | 0 | Active |
| [cfdns](https://github.com/simplesurance/cfdns) | Go | Go API for managing Cloudflare DNS | 2 | 0 | Active |
| [phpstan-extensions](https://github.com/simplesurance/phpstan-extensions) | — | Custom PHPStan rules | 2 | 1 | Active |
| [sqltracing](https://github.com/simplesurance/sqltracing) | Go | SQL driver wrapper for OpenTracing | 2 | 1 | Active |
| [dependencies-tool](https://github.com/simplesurance/dependencies-tool) | Go | Dependency graph visualization for CI | 1 | 1 | Active |
| [sqlmw](https://github.com/simplesurance/sqlmw) | Go | Interceptors for database/sql | 1 | 0 | Active |
| [directorius](https://github.com/simplesurance/directorius) | Go | — | 0 | 1 | Active |
| [smtpgo](https://github.com/simplesurance/smtpgo) | Go | Robust email library for Go | 0 | 0 | Active |
| [go-amqp](https://github.com/simplesurance/go-amqp) | Go | AMQP opentracing instrumentation | 0 | 0 | Active |
| [proteus-consul](https://github.com/simplesurance/proteus-consul) | — | Consul configuration provider for proteus | 0 | 0 | Active |
| [proteusfile](https://github.com/simplesurance/proteusfile) | — | File configuration provider for proteus | 0 | 0 | Active |
| [toastr-bower](https://github.com/simplesurance/toastr-bower) | JavaScript | toastr Bower package | 0 | 0 | Active |
| [bower-angular-translate](https://github.com/simplesurance/bower-angular-translate) | — | angular-translate Bower package | 0 | 0 | Active |
| [terraform-provider-bunny](https://github.com/simplesurance/terraform-provider-bunny) | Go | Terraform provider for bunny.net CDN | 15 | 8 | Archived |
| [bunny-go](https://github.com/simplesurance/bunny-go) | Go | Go library for bunny.net CDN API | 13 | 9 | Archived |
| [bunny-cli](https://github.com/simplesurance/bunny-cli) | Go | bunny.net API command-line client | 0 | 2 | Archived |
| [migrate](https://github.com/simplesurance/migrate) | Go | Database migration handling | 0 | 0 | Archived |

